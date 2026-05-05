-- 00000000000007_triggers.sql
-- auth.users INSERT 시 profiles 자동 생성 + updated_at 자동 갱신.

-- ─────────────────────────────────────────────────────────
-- 신규 가입자 → profiles 자동 생성 ('user' 기본 권한)
-- admin/beta 승격은 SQL Editor 또는 /admin/users에서 별도 처리.
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, email, display_name, role)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        COALESCE(NEW.raw_user_meta_data->>'role', 'user')
    )
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION handle_new_user();

-- ─────────────────────────────────────────────────────────
-- updated_at 자동 갱신 트리거 (profiles)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profiles_updated_at ON profiles;
CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON profiles
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────
-- us_kr_mapping.updated_at 자동 갱신
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_mapping_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS us_kr_mapping_updated_at ON us_kr_mapping;
CREATE TRIGGER us_kr_mapping_updated_at
    BEFORE UPDATE ON us_kr_mapping
    FOR EACH ROW
    EXECUTE FUNCTION set_mapping_updated_at();
