-- 00000000000009_foreign_keys.sql
-- Add foreign keys from ticker columns to stocks(ticker).
--
-- Why: Supabase PostgREST's resource-embedding syntax
--      `select=ticker,signal,stocks(name,sector)`  requires an actual
-- foreign-key relationship. Without it, the server returns
--   PGRST200: Could not find a relationship between 'ai_scores' and 'stocks'
-- and any nested-select query fails with HTTP 400.
--
-- ON DELETE RESTRICT — never auto-delete time-series rows when a stock is
-- removed from the watchlist. Manual cleanup is the correct path.

ALTER TABLE korea_market
    ADD CONSTRAINT korea_market_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

ALTER TABLE ai_scores
    ADD CONSTRAINT ai_scores_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

ALTER TABLE predictions
    ADD CONSTRAINT predictions_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

ALTER TABLE backtest_results
    ADD CONSTRAINT backtest_results_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

ALTER TABLE us_kr_mapping
    ADD CONSTRAINT us_kr_mapping_kr_ticker_fk
    FOREIGN KEY (kr_ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

-- Refresh PostgREST's schema cache so the new FKs are immediately visible.
NOTIFY pgrst, 'reload schema';
