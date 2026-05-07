-- 00000000000014_sector_betas_ai_commentary.sql
-- Two new capabilities:
--   1) kr_sector_betas — sector ETF ↔ KR ticker rolling beta (Phase A of
--      the 5-layer mapping strategy: sector ETFs explain ~25% of KR
--      stock variance, far more than per-stock 1:1 mappings alone).
--   2) ai_commentary — per-(date, ticker) Claude-generated qualitative
--      analysis stored alongside ai_scores. Web shows "AI 퀀트 전문가
--      분석" card on the stock detail page.

-- ────────────────────────────────────────────────────
-- Sector ETF beta (Phase A — Layer 2 of mapping system)
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kr_sector_betas (
    kr_ticker      VARCHAR(10) NOT NULL,
    etf_symbol     VARCHAR(20) NOT NULL,                  -- SOXX, XBI, LIT, ...
    beta           DOUBLE PRECISION NOT NULL,             -- regression coefficient
    r_squared      DOUBLE PRECISION,                      -- fit quality 0..1
    n_samples      INTEGER NOT NULL,                      -- usually 60
    computed_on    DATE NOT NULL,                         -- date of latest sample used
    PRIMARY KEY (kr_ticker, etf_symbol)
);

ALTER TABLE kr_sector_betas
    ADD CONSTRAINT kr_sector_betas_ticker_fk
    FOREIGN KEY (kr_ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS kr_sector_betas_ticker_idx
    ON kr_sector_betas (kr_ticker);

ALTER TABLE kr_sector_betas ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_kr_sector_betas ON kr_sector_betas FOR SELECT
    TO authenticated USING (TRUE);

-- ────────────────────────────────────────────────────
-- AI Quant Expert commentary (per stock, per date)
-- ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_commentary (
    date           DATE NOT NULL,
    ticker         VARCHAR(10) NOT NULL,
    headline       VARCHAR(200) NOT NULL,                 -- 한 줄 요약
    body           TEXT NOT NULL,                          -- 200-400자 분석
    short_term     TEXT,                                  -- 1주 전망
    mid_term       TEXT,                                  -- 1개월 전망
    catalysts      TEXT[],                                -- 긍정 카탈리스트
    risks          TEXT[],                                -- 리스크 시나리오
    model          VARCHAR(50) NOT NULL,                  -- claude-sonnet-4-6 등
    cost_estimate  DOUBLE PRECISION,                      -- USD
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (date, ticker)
);

ALTER TABLE ai_commentary
    ADD CONSTRAINT ai_commentary_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS ai_commentary_ticker_date_idx
    ON ai_commentary (ticker, date DESC);

ALTER TABLE ai_commentary ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_ai_commentary ON ai_commentary FOR SELECT
    TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
