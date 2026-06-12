-- 00000000000038_kr_short_selling.sql
-- 공매도 데이터 (audit 2순위) — 한국시장 학술 증거가 가장 강한 신호의
-- 나머지 절반 (외국인 수급은 B1에서 확보; KAIST NAT = 보유 anomaly
-- MINUS 공매도 anomaly).
--
-- 원천: pykrx (KRX 로그인 필요, KRX_ID/KRX_PW secrets)
--   · 거래량: get_shorting_volume_by_date  (T+1 공표)
--   · 잔고  : get_shorting_balance_by_date (T+2 공표)

CREATE TABLE IF NOT EXISTS kr_short_selling (
    ticker          VARCHAR(10) NOT NULL,
    date            DATE        NOT NULL,
    short_volume    BIGINT,      -- 공매도 거래량 (주)
    total_volume    BIGINT,      -- 전체 거래량 — 비중 계산용
    short_ratio     FLOAT,       -- 공매도 거래비중 (%)
    balance_qty     BIGINT,      -- 공매도 잔고 (주, T+2)
    balance_ratio   FLOAT,       -- 잔고/상장주식수 비중 (%)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, date)
);
CREATE INDEX IF NOT EXISTS kr_short_selling_date_idx ON kr_short_selling (date DESC);

COMMENT ON TABLE kr_short_selling IS
    'KRX 공매도 거래량/잔고 — collectors/kr_short.py (pykrx, KRX 로그인)';

ALTER TABLE kr_short_selling ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kr_short_selling_read ON kr_short_selling;
CREATE POLICY kr_short_selling_read ON kr_short_selling
    FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
