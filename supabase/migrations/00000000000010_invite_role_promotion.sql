-- 00000000000010_invite_role_promotion.sql
-- handle_new_user → invite_codes 조회로 beta/user role 자동 결정.
--
-- Why: Phase 1 베타는 admin이 발급한 invite_codes(code,email,role)을 통해서만
-- 가입한다. 사용자가 raw_user_meta_data로 role을 직접 지정하지 못하도록
-- (자가 권한 상승 방지) 트리거가 invite_codes 테이블을 SECURITY DEFINER로
-- 직접 조회해 role을 결정한다.
--
-- 우선순위:
--   1. invite_token이 있고 invite_codes에서 검증되면 → invite.role
--   2. 그 외 → 'user' (기본)

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    invite_token TEXT;
    resolved_role TEXT := 'user';
    invite_row RECORD;
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

    INSERT INTO public.profiles (id, email, display_name, role)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        resolved_role
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;
