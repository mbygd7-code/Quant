-- 00000000000031_kr_trade_stats.sql
-- 9th weighted factor: 수출입 동향 (Korea customs export/import trends).
--
-- Evidence basis (2026-06-10 validation against our own price DB):
--   coincident  exp(t)~ret(t)   ρ=+0.40~0.43 (삼성전자/현대차)
--   predictive  exp(t)~ret(t+1) ρ=+0.30 (not significant, n=18)
--   reverse     ret(t)~exp(t+1) ρ=+0.19~0.41 (stocks lead exports too)
-- → exports CONFIRM trends rather than predict them, so the factor
--   enters at a deliberately small weight (0.04), as a slow
--   sector-level confirmation signal. Monthly cadence (관세청 확정치
--   ~15th of following month via data.go.kr API).
--
-- Rollback: set kr_trade_weight = 0 on all rows; the 9th term
-- vanishes from _combine with no code change.

-- ── Raw monthly trade stats per HS code ─────────────────────────
CREATE TABLE IF NOT EXISTS kr_trade_stats (
    hs_code        TEXT NOT NULL,            -- e.g. '8542', '8507', '30'
    period         TEXT NOT NULL,            -- 'YYYY-MM'
    export_usd     BIGINT,                   -- monthly export value (USD)
    import_usd     BIGINT,
    trade_balance  BIGINT,
    export_yoy     FLOAT,                    -- computed vs period-12m (NULL if base missing)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (hs_code, period)
);

COMMENT ON TABLE kr_trade_stats IS
    '관세청 품목별(HS) 월간 수출입실적 — collectors/kr_trade.py (data.go.kr API)';

-- Service-role-only table (backend pipeline writes, web reads via API).
ALTER TABLE kr_trade_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY kr_trade_stats_read ON kr_trade_stats
    FOR SELECT TO authenticated USING (true);

-- ── 9th weight column + per-score column ────────────────────────
ALTER TABLE weight_configs
    ADD COLUMN IF NOT EXISTS kr_trade_weight FLOAT NOT NULL DEFAULT 0.04;

ALTER TABLE ai_scores
    ADD COLUMN IF NOT EXISTS kr_trade_score FLOAT;

-- Renormalize existing rows: scale the 8 current weights by 0.96 so
-- the 9 components sum to 1.00 with the new factor at 0.04.
UPDATE weight_configs SET
    global_market_weight    = ROUND((global_market_weight    * 0.96)::NUMERIC, 4),
    sector_weight           = ROUND((sector_weight           * 0.96)::NUMERIC, 4),
    related_us_stock_weight = ROUND((related_us_stock_weight * 0.96)::NUMERIC, 4),
    news_sentiment_weight   = ROUND((news_sentiment_weight   * 0.96)::NUMERIC, 4),
    fundamental_weight      = ROUND((fundamental_weight      * 0.96)::NUMERIC, 4),
    volume_flow_weight      = ROUND((volume_flow_weight      * 0.96)::NUMERIC, 4),
    risk_penalty_weight     = ROUND((risk_penalty_weight     * 0.96)::NUMERIC, 4),
    kr_fear_greed_weight    = ROUND((kr_fear_greed_weight    * 0.96)::NUMERIC, 4)
WHERE kr_trade_weight = 0.04;  -- only rows not yet touched by the UI

-- Absorb rounding drift into the new column on the active row so the
-- UI's "합계 1.00 ✓" check passes.
UPDATE weight_configs
SET kr_trade_weight = ROUND(
    (1.0
        - global_market_weight
        - sector_weight
        - related_us_stock_weight
        - news_sentiment_weight
        - fundamental_weight
        - volume_flow_weight
        - risk_penalty_weight
        - kr_fear_greed_weight
    )::NUMERIC,
    4
)
WHERE is_active = TRUE;

NOTIFY pgrst, 'reload schema';
