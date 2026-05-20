-- 00000000000027_simple_signup.sql
-- Drastic simplification per family-mode request: auto-approve every
-- new signup, drop the pending queue from the default flow. The
-- approval columns + admin UI stay in place so we can re-enable later
-- by just changing the trigger default back, but the day-to-day flow
-- becomes "sign up → log in → dashboard."
--
-- Email confirmation is also disabled — this migration only handles
-- the DB side; the operator must turn off "Confirm email" in
-- Supabase Dashboard → Authentication → Sign In / Up. (Lower the
-- password min length to 4 in the same place.)

-- ── 1. Flip every outstanding pending row to approved ──────────
-- Otherwise existing test accounts would still be blocked.
UPDATE profiles
   SET approval_status = 'approved',
       approved_at     = COALESCE(approved_at, NOW())
 WHERE approval_status IN ('pending', 'expired');

-- ── 2. handle_new_user — every signup is approved immediately ──
-- We keep the invite_token branch as dead code in case we ever
-- restore the gated flow; the only difference now is the default
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
