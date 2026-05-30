-- 00000000000029_overnight_betas.sql
-- Overnight US → KR open lead-lag betas.
--
-- THE signal behind this whole product ("미국 마감 → 한국 시작"). Empirically
-- validated: KR daily return regressed on the PREVIOUS US session return
-- has 2-4× the correlation of the same-date regression, because KR trades
-- in its morning (KST) before the US opens that calendar day. Examples
-- (120-day window, 2026-05):
--   SK하이닉스 000660 ~ ^SOX(t-1): ρ≈+0.39   (same-day only +0.14)
--   삼성전자   005930 ~ ^SOX(t-1): ρ≈+0.35   (same-day only +0.10)
--
-- Distinct from kr_sector_betas (same-date, feeds sector_score) — this
-- table is lag-1 and feeds the open-gap term in the price forecast.
--
-- Model: kr_return_t = α + β · us_return_{t-1} + ε   over last N sessions.
-- We store the best-R² US proxy per ticker.

CREATE TABLE IF NOT EXISTS kr_overnight_betas (
    kr_ticker    VARCHAR(10)      NOT NULL,
    us_symbol    VARCHAR(20)      NOT NULL,   -- ^SOX, ^IXIC, ^GSPC, LIT, CARZ, XBI ...
    beta         DOUBLE PRECISION NOT NULL,   -- KR move per 1.0 US overnight move
    correlation  DOUBLE PRECISION,            -- Pearson ρ (signed)
    r_squared    DOUBLE PRECISION,            -- ρ²
    n_samples    INTEGER          NOT NULL,
    computed_on  DATE             NOT NULL,
    PRIMARY KEY (kr_ticker, us_symbol)
);

ALTER TABLE kr_overnight_betas
    ADD CONSTRAINT kr_overnight_betas_ticker_fk
    FOREIGN KEY (kr_ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS kr_overnight_betas_ticker_idx
    ON kr_overnight_betas (kr_ticker);

ALTER TABLE kr_overnight_betas ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_kr_overnight_betas ON kr_overnight_betas FOR SELECT
    TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
