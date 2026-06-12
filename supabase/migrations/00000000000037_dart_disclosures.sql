-- 00000000000037_dart_disclosures.sql
-- DART 공시 이벤트 스트림 (audit 5번 항목의 3순위 보강).
--
-- Watchlist 종목의 일일 공시를 수집해 이벤트 신호의 원천으로 쓴다:
--   · Taleb — 잠정실적/주요 이벤트 공시 발생 = 불확실성 신호
--   · 리포트/UI — "오늘의 공시" 근거 표시 (향후)
--   · 향후 이벤트 드리븐 시그널 (유상증자/자사주/공급계약 ...)
--
-- rcept_no는 DART의 전역 고유 접수번호 — 자연키 그대로 PK.

CREATE TABLE IF NOT EXISTS dart_disclosures (
    rcept_no    VARCHAR(14) PRIMARY KEY,        -- DART 접수번호
    ticker      VARCHAR(10) NOT NULL,
    corp_name   TEXT,
    report_nm   TEXT NOT NULL,                  -- 공시 제목 (보고서명)
    category    TEXT NOT NULL DEFAULT '기타',    -- 분류 (실적/자사주/증자 ...)
    rcept_dt    DATE NOT NULL,                  -- 접수일
    url         TEXT,                           -- DART 뷰어 링크
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dart_disclosures_ticker_dt_idx
    ON dart_disclosures (ticker, rcept_dt DESC);
CREATE INDEX IF NOT EXISTS dart_disclosures_category_idx
    ON dart_disclosures (category, rcept_dt DESC);

COMMENT ON TABLE dart_disclosures IS
    'DART 일일 공시 이벤트 — collectors/dart_events.py (list.json)';

ALTER TABLE dart_disclosures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dart_disclosures_read ON dart_disclosures;
CREATE POLICY dart_disclosures_read ON dart_disclosures
    FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
