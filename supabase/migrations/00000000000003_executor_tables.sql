-- 00000000000003_executor_tables.sql
-- Phase 2~3 executor 모듈 테이블 — 백테스트 작업 / 페이퍼 트레이딩.

-- ─────────────────────────────────────────────────────────
-- 백테스트 작업 (사용자 트리거 비동기 실행)
-- 웹 → apps/api → GitHub workflow_dispatch → Runner가 진행률 업데이트
-- ─────────────────────────────────────────────────────────
CREATE TABLE backtest_jobs (
    id            UUID        PRIMARY KEY,
    status        VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued|running|completed|failed
    params        JSONB       NOT NULL,
    progress      INTEGER     DEFAULT 0,                  -- 0~100
    result_url    TEXT,                                   -- Storage signed URL (PNG/HTML)
    error         TEXT,
    run_url       TEXT,                                   -- GitHub Actions 실행 URL
    created_by    UUID        REFERENCES auth.users(id),
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ
);
CREATE INDEX backtest_jobs_user_idx   ON backtest_jobs (created_by, created_at DESC);
CREATE INDEX backtest_jobs_status_idx ON backtest_jobs (status);

-- ─────────────────────────────────────────────────────────
-- Paper Trading (Phase 2)
-- ─────────────────────────────────────────────────────────
CREATE TABLE paper_trades (
    id            UUID        PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id       UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
    date          DATE        NOT NULL,
    ticker        VARCHAR(10) NOT NULL,
    side          VARCHAR(4)  NOT NULL CHECK (side IN ('buy', 'sell')),
    qty           INTEGER     NOT NULL,
    price         INTEGER     NOT NULL,
    triggered_by  VARCHAR(50),                            -- 'signal:강한관심' | 'manual' | ...
    pnl           BIGINT,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX paper_trades_user_date_idx ON paper_trades (user_id, date DESC);

CREATE TABLE paper_portfolio (
    user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    ticker        VARCHAR(10) NOT NULL,
    qty           INTEGER     NOT NULL,
    avg_cost      INTEGER     NOT NULL,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, ticker)
);
