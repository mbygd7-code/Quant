-- 00000000000006_rpc_functions.sql
-- pgvector 유사도 검색 + 텔레그램 연동 RPC.

-- ─────────────────────────────────────────────────────────
-- match_rag_chunks — RAG 청크 코사인 유사도 검색
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION match_rag_chunks(
    query_embedding   extensions.vector(1536),
    match_count       INT,
    filter_tickers    TEXT[] DEFAULT NULL,
    filter_sectors    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    id              VARCHAR,
    topic           TEXT,
    body            TEXT,
    related_tickers TEXT[],
    sectors         TEXT[],
    similarity      FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.topic,
        c.body,
        c.related_tickers,
        c.sectors,
        1 - (c.embedding <=> query_embedding) AS similarity
    FROM rag_chunks c
    WHERE (filter_tickers IS NULL OR c.related_tickers && filter_tickers)
      AND (filter_sectors IS NULL OR c.sectors && filter_sectors)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ─────────────────────────────────────────────────────────
-- match_news_embeddings — 뉴스 유사도 검색 (날짜 필터 포함)
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION match_news_embeddings(
    query_embedding   extensions.vector(1536),
    match_count       INT,
    since_date        DATE DEFAULT NULL,
    filter_symbols    TEXT[] DEFAULT NULL
)
RETURNS TABLE (
    id               INT,
    date             DATE,
    title            TEXT,
    body             TEXT,
    sentiment_score  FLOAT,
    similarity       FLOAT
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT
        n.id,
        n.date,
        n.title,
        n.body,
        n.sentiment_score,
        1 - (n.embedding <=> query_embedding) AS similarity
    FROM news_items n
    WHERE (since_date IS NULL OR n.date >= since_date)
      AND (filter_symbols IS NULL OR n.related_symbols && filter_symbols)
      AND n.embedding IS NOT NULL
    ORDER BY n.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ─────────────────────────────────────────────────────────
-- link_telegram — 일회용 코드로 telegram_chat_id 연동
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION link_telegram(
    p_user_id   UUID,
    p_link_code VARCHAR(10),
    p_chat_id   VARCHAR(50)
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
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

    UPDATE profiles
       SET telegram_chat_id      = p_chat_id,
           telegram_link_code    = NULL,
           link_code_expires_at  = NULL,
           updated_at            = NOW()
     WHERE id = p_user_id;

    RETURN QUERY SELECT TRUE, '연동이 완료되었습니다.';
END;
$$;
