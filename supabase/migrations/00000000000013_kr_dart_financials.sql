-- 00000000000013_kr_dart_financials.sql
-- DART 공시 기반 KR 종목 재무제표 + corp_code 매핑.
--
-- DART API는 회사고유번호(corp_code)로 조회하므로 ticker → corp_code
-- 매핑 테이블이 먼저 필요. corp_code는 한 번 다운로드 후 거의 안 바뀜.
--
-- kr_financials는 분기별 grain. 매출액/영업이익/당기순이익 + YoY
-- 성장률 (scorer가 사용). period_end 기준으로 정렬.

-- ────────────────────────────────────────────────────
-- corp_code 매핑 (ticker ↔ DART 회사고유번호)
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kr_corp_codes (
    ticker      VARCHAR(10) PRIMARY KEY,
    corp_code   VARCHAR(10) NOT NULL UNIQUE,
    corp_name   VARCHAR(100) NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE kr_corp_codes
    ADD CONSTRAINT kr_corp_codes_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

ALTER TABLE kr_corp_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_corp_codes ON kr_corp_codes FOR SELECT
    TO authenticated USING (TRUE);

-- ────────────────────────────────────────────────────
-- 분기별 재무제표 (DART fnlttSinglAcnt)
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kr_financials (
    ticker            VARCHAR(10)  NOT NULL,
    fiscal_year       INTEGER      NOT NULL,            -- 2025
    reprt_code        VARCHAR(8)   NOT NULL,            -- 11013(Q1) 11012(반기) 11014(Q3) 11011(연간)
    period_end        DATE,                             -- 분기/연간 종료일
    revenue           BIGINT,                           -- 매출액 (KRW)
    operating_income  BIGINT,                           -- 영업이익
    net_income        BIGINT,                           -- 당기순이익
    revenue_yoy       DOUBLE PRECISION,                 -- (current - prev_year) / prev_year
    op_income_yoy     DOUBLE PRECISION,
    net_income_yoy    DOUBLE PRECISION,
    fetched_at        TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (ticker, fiscal_year, reprt_code)
);

ALTER TABLE kr_financials
    ADD CONSTRAINT kr_financials_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS kr_financials_ticker_period_idx
    ON kr_financials (ticker, period_end DESC);

ALTER TABLE kr_financials ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_kr_financials ON kr_financials FOR SELECT
    TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
