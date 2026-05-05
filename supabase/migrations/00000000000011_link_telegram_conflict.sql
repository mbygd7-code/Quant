-- 00000000000011_link_telegram_conflict.sql
-- link_telegram RPC: 같은 chat_id가 다른 프로필에 이미 연결되어 있으면 해제 후 새로 연결.
--
-- Why: 기존 RPC는 새 사용자에게만 chat_id를 부여했다. 한 텔레그램 계정으로
-- 여러 웹앱 프로필에 /link를 시도하면 양쪽 모두 같은 chat_id를 갖게 되어
-- 일일 발송 시 중복 발송 + 권한 분리 위반이 발생할 수 있다. 새 연결을
-- 우선시하고 기존 연결은 자동 해제한다.

CREATE OR REPLACE FUNCTION link_telegram(
    p_user_id   UUID,
    p_link_code VARCHAR(10),
    p_chat_id   VARCHAR(50)
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile RECORD;
BEGIN
    SELECT id, telegram_link_code, link_code_expires_at
      INTO v_profile
      FROM profiles
     WHERE id = p_user_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, '프로필을 찾을 수 없습니다.';
        RETURN;
    END IF;

    IF v_profile.telegram_link_code IS NULL
       OR v_profile.telegram_link_code <> p_link_code THEN
        RETURN QUERY SELECT FALSE, '연동 코드가 일치하지 않습니다.';
        RETURN;
    END IF;

    IF v_profile.link_code_expires_at < NOW() THEN
        RETURN QUERY SELECT FALSE, '연동 코드가 만료되었습니다. 웹앱에서 재발급해주세요.';
        RETURN;
    END IF;

    -- Same chat_id elsewhere → release the old binding before assigning here.
    UPDATE profiles
       SET telegram_chat_id = NULL,
           updated_at       = NOW()
     WHERE telegram_chat_id = p_chat_id
       AND id <> p_user_id;

    UPDATE profiles
       SET telegram_chat_id      = p_chat_id,
           telegram_link_code    = NULL,
           link_code_expires_at  = NULL,
           updated_at            = NOW()
     WHERE id = p_user_id;

    RETURN QUERY SELECT TRUE, '연동이 완료되었습니다.';
END;
$$;
