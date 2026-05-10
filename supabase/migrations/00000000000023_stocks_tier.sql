-- 23 · stocks.tier — universe stratification for cost-optimised cron
--
-- Three tiers control how often M4 cycle analyses each ticker:
--
--   S — Core watchlist     analysed every cron (3×/day)
--   A — Active watch       analysed at the morning cron only (1×/day)
--   B — Universe scan      analysed at the morning cron only (1×/day)
--
-- The agents-cycle.yml workflow filters tickers by tier per schedule:
--   07 KST  →  --tier S,A,B   (full universe, all 50)
--   12 KST  →  --tier S       (core only)
--   16 KST  →  --tier S       (core only)
--
-- This drops daily LLM calls from ~1,050 to ~350-400 (-65%) without
-- sacrificing signal coverage on the most-watched names.

ALTER TABLE stocks
    ADD COLUMN tier CHAR(1) NOT NULL DEFAULT 'A'
    CHECK (tier IN ('S', 'A', 'B'));

CREATE INDEX stocks_tier_idx ON stocks (tier) WHERE is_watchlist = TRUE;

COMMENT ON COLUMN stocks.tier IS
    'Universe stratification: S=core (3×/day), A=active (1×/day), B=scan (1×/day). Default A.';

-- Initial tier classification for the M2-T0 watchlist of 50 tickers.
-- S tier picks the 10 most-traded / most-news-driven names (one per
-- sector, plus the obvious heavy-cap KOSPI). A tier gets the rest of
-- the named watchlist.

UPDATE stocks SET tier = 'S' WHERE ticker IN (
    -- Semiconductors: Samsung, SK Hynix, Hanmi Semi
    '005930', '000660', '042700',
    -- Battery: LG Energy, Samsung SDI
    '373220', '006400',
    -- Auto: Hyundai
    '005380',
    -- Bio: Samsung Bio, Celltrion
    '207940', '068270',
    -- Internet: NAVER, Kakao
    '035420', '035720'
);

-- The remaining 39 watchlist names default to A. Future additions can
-- arrive at B (cheap scanning) and graduate to A/S based on actual
-- engagement / signal quality.

NOTIFY pgrst, 'reload schema';
