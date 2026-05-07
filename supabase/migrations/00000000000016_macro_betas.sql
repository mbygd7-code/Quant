-- 00000000000016_macro_betas.sql
-- Layer 3 of the 5-layer mapping strategy: macro variable betas.
--
-- Five exogenous macro factors that drive the KR market structurally:
--   USDKRW   — KRW weakness lifts exporters, hurts importers
--   ^TNX     — 10Y UST yield: rising → growth-stock multiple compression
--   ^VIX     — risk aversion / position unwind
--   DXY      — broad USD strength: foreign capital flow signal
--   WTI      — refining/transport/airline directly; chemical inputs indirect
--
-- Each (kr_ticker, factor) pair gets a 60-day OLS beta + R². Scorer
-- multiplies today's macro change_rate by beta to get the macro
-- contribution score.

CREATE TABLE IF NOT EXISTS kr_macro_betas (
    kr_ticker      VARCHAR(10) NOT NULL,
    macro_factor   VARCHAR(20) NOT NULL,                 -- USDKRW, ^TNX, ^VIX, DXY, WTI
    beta           DOUBLE PRECISION NOT NULL,
    r_squared      DOUBLE PRECISION,
    n_samples      INTEGER NOT NULL,
    computed_on    DATE NOT NULL,
    PRIMARY KEY (kr_ticker, macro_factor)
);

ALTER TABLE kr_macro_betas
    ADD CONSTRAINT kr_macro_betas_ticker_fk
    FOREIGN KEY (kr_ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS kr_macro_betas_ticker_idx
    ON kr_macro_betas (kr_ticker);

ALTER TABLE kr_macro_betas ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_kr_macro_betas ON kr_macro_betas FOR SELECT
    TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
