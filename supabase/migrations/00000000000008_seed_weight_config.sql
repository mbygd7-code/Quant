-- 00000000000008_seed_weight_config.sql
-- 기본 weight_configs v1.0 활성화 — SKILL.md 3번 기본값.

INSERT INTO weight_configs (
    version,
    global_market_weight,
    sector_weight,
    related_us_stock_weight,
    news_sentiment_weight,
    fundamental_weight,
    volume_flow_weight,
    risk_penalty_weight,
    signal_threshold_strong,
    signal_threshold_interest,
    signal_threshold_neutral,
    signal_threshold_caution,
    is_active,
    notes
)
VALUES (
    'v1.0',
    0.20, 0.20, 0.20, 0.15, 0.10, 0.10, 0.05,
    0.80, 0.65, 0.50, 0.35,
    TRUE,
    'Initial baseline weights — SKILL.md §3'
)
ON CONFLICT DO NOTHING;
