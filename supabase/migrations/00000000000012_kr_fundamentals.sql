-- 00000000000012_kr_fundamentals.sql
-- KR 종목 펀더멘털 스냅샷.
--
-- pykrx는 클라우드 IP 차단으로 사용 불가, DART는 corp_code 매핑/분기 보고서
-- 파싱이 무거워서 별도 작업으로 미룬다. 1차 구현은 yfinance .info에서
-- forwardPE / ROE / marketCap 만 가져온다 (KR 종목은 yfinance가
-- trailingPE / priceToBook은 None인 경우가 많음).
--
-- (date, ticker) 단위. 매일 06:00 KST 파이프라인이 upsert.

CREATE TABLE IF NOT EXISTS kr_fundamentals (
    date           DATE        NOT NULL,
    ticker         VARCHAR(10) NOT NULL,
    forward_pe     DOUBLE PRECISION,
    trailing_pe    DOUBLE PRECISION,
    price_to_book  DOUBLE PRECISION,
    roe            DOUBLE PRECISION,                       -- 0.18 = 18%
    market_cap     BIGINT,                                 -- KRW
    source         VARCHAR(20)  NOT NULL DEFAULT 'yfinance',
    created_at     TIMESTAMPTZ  DEFAULT NOW(),
    PRIMARY KEY (date, ticker)
);

CREATE INDEX IF NOT EXISTS kr_fundamentals_ticker_date_idx
  ON kr_fundamentals (ticker, date DESC);

-- FK to stocks(ticker) for PostgREST resource embedding (consistency w/ other tables).
ALTER TABLE kr_fundamentals
    ADD CONSTRAINT kr_fundamentals_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

-- RLS: read-only for authenticated, write only by service_role.
ALTER TABLE kr_fundamentals ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_kr_fundamentals ON kr_fundamentals FOR SELECT
    TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
