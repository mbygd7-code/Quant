-- 00000000000026_user_approval.sql
-- Self-signup + admin-approval gate.
--
-- Phase 2 transition per CLAUDE.md §2-3: allow anyone to sign up, but
-- gate everything except /pending behind admin approval. Existing
-- admin/beta rows are grandfathered to approved.
--
-- State machine on profiles.approval_status:
--   pending   — just signed up, awaiting admin review (or just confirmed email)
--   approved  — admin reviewed + assigned role (user|beta), full access
--   rejected  — admin denied, can reapply
--   expired   — admin didn't review within 5 business days, can reapply
--
-- The expiry job runs daily via GitHub Actions
-- (scripts/expire_pending_signups.py) — separate PR.

-- ── 1. Column additions ─────────────────────────────────────────
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS approval_status  VARCHAR(20)  NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS approval_note    TEXT,
    ADD COLUMN IF NOT EXISTS approved_by      UUID         REFERENCES profiles(id),
    ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reapplied_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reapply_count    INTEGER      NOT NULL DEFAULT 0;

-- Enforce the 4 valid states.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_approval_status_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected', 'expired'));

-- ── 2. Grandfather every existing profile ───────────────────────
-- Anyone created before this migration is implicitly approved — we
-- don't want to lock out current admin/beta users when we deploy.
UPDATE profiles
   SET approval_status = 'approved',
       approved_at     = COALESCE(approved_at, created_at, NOW())
 WHERE approval_status IS NULL OR approval_status = 'pending';

-- ── 3. Index for the admin pending queue + expiry job ───────────
-- Partial index keeps the hot path tiny since most rows are 'approved'.
CREATE INDEX IF NOT EXISTS profiles_pending_expiry_idx
    ON profiles (approval_status, created_at, reapplied_at)
 WHERE approval_status = 'pending';

-- ── 4. handle_new_user trigger — set pending for self-signups ───
-- Invite-based signups (invite_token in metadata) stay auto-approved
-- because an admin already vetted them by issuing the invite. All
-- other signups (the new /signup page) land as pending.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    invite_token         TEXT;
    resolved_role        TEXT := 'user';
    resolved_approval    TEXT := 'pending';
    resolved_approved_at TIMESTAMPTZ := NULL;
    invite_row           RECORD;
BEGIN
    invite_token := NEW.raw_user_meta_data->>'invite_token';

    IF invite_token IS NOT NULL AND length(invite_token) > 0 THEN
        SELECT code, email, role, expires_at, used_at
          INTO invite_row
          FROM public.invite_codes
         WHERE code = invite_token;

        IF FOUND
           AND invite_row.used_at IS NULL
           AND (invite_row.expires_at IS NULL OR invite_row.expires_at > NOW())
           AND lower(invite_row.email) = lower(NEW.email)
        THEN
            -- Admin-vetted: skip approval queue.
            resolved_role        := invite_row.role;
            resolved_approval    := 'approved';
            resolved_approved_at := NOW();

            UPDATE public.invite_codes
               SET used_at = NOW()
             WHERE code = invite_token;
        END IF;
    END IF;

    INSERT INTO public.profiles (
        id, email, display_name, role,
        approval_status, approved_at
    )
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        resolved_role,
        resolved_approval,
        resolved_approved_at
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';
