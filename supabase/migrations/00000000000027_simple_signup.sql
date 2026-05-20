-- 00000000000027_simple_signup.sql
-- Drastic simplification per family-mode request: auto-approve every
-- new signup, drop the pending queue from the default flow.
--
-- Self-contained: if migration 26's columns aren't present yet (e.g.
-- 26 was skipped or never ran), we add them here with the new default
-- of 'approved' so this file works as a standalone install.
--
-- Operator must also (one-time, Supabase Dashboard):
--   Authentication → Providers → Email: "Confirm email" OFF
--   Authentication → Policies: min password length = 4

-- ── 1. Ensure the approval columns exist ───────────────────────
ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS approval_status  VARCHAR(20)  NOT NULL DEFAULT 'approved',
    ADD COLUMN IF NOT EXISTS approval_note    TEXT,
    ADD COLUMN IF NOT EXISTS approved_by      UUID         REFERENCES profiles(id),
    ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reapplied_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reapply_count    INTEGER      NOT NULL DEFAULT 0;

-- Change the default in case 26 already created it with 'pending'.
ALTER TABLE profiles ALTER COLUMN approval_status SET DEFAULT 'approved';

-- (Re)enforce the 4 valid states.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_approval_status_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_approval_status_check
    CHECK (approval_status IN ('pending', 'approved', 'rejected', 'expired'));

-- ── 2. Flip every non-approved row to approved ─────────────────
UPDATE profiles
   SET approval_status = 'approved',
       approved_at     = COALESCE(approved_at, created_at, NOW())
 WHERE approval_status IS NULL
    OR approval_status IN ('pending', 'expired');

-- Partial index for the (now-likely-empty) pending queue. Kept so the
-- admin UI still works if we ever flip a row back to 'pending'.
CREATE INDEX IF NOT EXISTS profiles_pending_expiry_idx
    ON profiles (approval_status, created_at, reapplied_at)
 WHERE approval_status = 'pending';

-- ── 3. handle_new_user — every signup is approved immediately ──
-- Keep the invite_token branch as dead code in case we restore the
-- gated flow later; the only difference now is the default value of
-- resolved_approval.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    invite_token         TEXT;
    resolved_role        TEXT := 'user';
    resolved_approval    TEXT := 'approved';
    resolved_approved_at TIMESTAMPTZ := NOW();
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
            resolved_role := invite_row.role;
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
