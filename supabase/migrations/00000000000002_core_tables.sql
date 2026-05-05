-- 00000000000002_core_tables.sql
-- 시장/뉴스/공시/AI 점수/예측/RAG/알림 — SKILL.md 2-1번 핵심 테이블.

-- ─────────────────────────────────────────────────────────
-- 종목 마스터
-- ─────────────────────────────────────────────────────────
CREATE TABLE stocks (
    id            SERIAL PRIMARY KEY,
    ticker        VARCHAR(10) UNIQUE NOT NULL,
    name          VARCHAR(100) NOT NULL,
    market        VARCHAR(20)  NOT NULL,           -- KOSPI, KOSDAQ, NASDAQ, NYSE
    sector        VARCHAR(50),
    industry      VARCHAR(100),
    is_watchlist  BOOLEAN      DEFAULT FALSE,
    created_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX stocks_market_idx     ON stocks (market);
CREATE INDEX stocks_sector_idx     ON stocks (sector);
CREATE INDEX stocks_watchlist_idx  ON stocks (is_watchlist) WHERE is_watchlist = TRUE;

-- ─────────────────────────────────────────────────────────
-- US → KR 매핑 (알파의 핵심)
-- ─────────────────────────────────────────────────────────
CREATE TABLE us_kr_mapping (
    id               SERIAL PRIMARY KEY,
    us_symbol        VARCHAR(10)  NOT NULL,
    kr_ticker        VARCHAR(10)  NOT NULL,
    relation_type    VARCHAR(50),                  -- 'supply_chain' | 'competitor' | 'sector_proxy' | 'fx_export' ...
    impact_strength  FLOAT        NOT NULL CHECK (impact_strength BETWEEN 0 AND 1),
    rationale        TEXT,
    updated_at       TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE (us_symbol, kr_ticker)
);
CREATE INDEX us_kr_mapping_kr_idx ON us_kr_mapping (kr_ticker);
CREATE INDEX us_kr_mapping_us_idx ON us_kr_mapping (us_symbol);

-- ─────────────────────────────────────────────────────────
-- 한국 시장 일별 데이터
-- ─────────────────────────────────────────────────────────
CREATE TABLE korea_market (
    date                 DATE        NOT NULL,
    ticker               VARCHAR(10) NOT NULL,
    open                 INTEGER,
    high                 INTEGER,
    low                  INTEGER,
    close                INTEGER,
    volume               BIGINT,
    trading_value        BIGINT,
    foreign_net_buy      BIGINT,
    institution_net_buy  BIGINT,
    change_rate          FLOAT,
    PRIMARY KEY (date, ticker)
);
CREATE INDEX korea_market_ticker_date_idx ON korea_market (ticker, date DESC);

-- ─────────────────────────────────────────────────────────
-- 글로벌 시장 데이터
-- ─────────────────────────────────────────────────────────
CREATE TABLE global_market (
    date         DATE        NOT NULL,
    symbol       VARCHAR(20) NOT NULL,
    close        FLOAT,
    change_rate  FLOAT,
    volume       BIGINT,
    asset_class  VARCHAR(20),                      -- 'equity' | 'index' | 'fx' | 'commodity' | 'rate'
    PRIMARY KEY (date, symbol)
);
CREATE INDEX global_market_symbol_date_idx ON global_market (symbol, date DESC);

-- ─────────────────────────────────────────────────────────
-- 뉴스 (감성 + 임베딩)
-- ─────────────────────────────────────────────────────────
CREATE TABLE news_items (
    id               SERIAL PRIMARY KEY,
    date             DATE        NOT NULL,
    published_at     TIMESTAMPTZ,
    source           VARCHAR(50),
    title            TEXT        NOT NULL,
    body             TEXT,
    url              TEXT        UNIQUE,
    related_symbols  TEXT[],
    sentiment_score  FLOAT       CHECK (sentiment_score BETWEEN 0 AND 1),
    sentiment_label  VARCHAR(20),                  -- very_negative | negative | neutral | positive | very_positive
    importance       VARCHAR(10),                  -- low | medium | high
    embedding        extensions.vector(1536),
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX news_items_date_idx       ON news_items (date DESC);
CREATE INDEX news_items_embedding_idx  ON news_items USING ivfflat (embedding extensions.vector_cosine_ops) WITH (lists = 100);

-- ─────────────────────────────────────────────────────────
-- 공시 (DART + SEC)
-- ─────────────────────────────────────────────────────────
CREATE TABLE filings (
    id           SERIAL PRIMARY KEY,
    date         DATE NOT NULL,
    company      VARCHAR(100),
    ticker       VARCHAR(10),
    market       VARCHAR(20),                      -- 'KR' | 'US'
    filing_type  VARCHAR(50),
    summary      TEXT,
    risk_label   VARCHAR(20),                      -- positive | neutral | caution | risk
    raw_url      TEXT
);
CREATE INDEX filings_date_idx          ON filings (date DESC);
CREATE INDEX filings_ticker_date_idx   ON filings (ticker, date DESC);

-- ─────────────────────────────────────────────────────────
-- AI 점수 (일별 종목별)
-- ─────────────────────────────────────────────────────────
CREATE TABLE ai_scores (
    date                    DATE        NOT NULL,
    ticker                  VARCHAR(10) NOT NULL,
    global_market_score     FLOAT,
    sector_score            FLOAT,
    related_us_stock_score  FLOAT,
    news_sentiment_score    FLOAT,
    fundamental_score       FLOAT,
    volume_flow_score       FLOAT,
    risk_penalty            FLOAT,
    final_score             FLOAT       NOT NULL,
    signal                  VARCHAR(20) NOT NULL,  -- 강한관심 | 관심 | 관망 | 주의 | 위험
    rationale_json          JSONB,
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (date, ticker)
);
CREATE INDEX ai_scores_date_score_idx  ON ai_scores (date DESC, final_score DESC);
CREATE INDEX ai_scores_signal_idx      ON ai_scores (date DESC, signal);

-- ─────────────────────────────────────────────────────────
-- ML 예측
-- ─────────────────────────────────────────────────────────
CREATE TABLE predictions (
    date                 DATE        NOT NULL,
    ticker               VARCHAR(10) NOT NULL,
    prob_up              FLOAT,
    expected_volatility  VARCHAR(10),
    gap_risk             VARCHAR(10),
    model_confidence     FLOAT,
    model_version        VARCHAR(20),
    PRIMARY KEY (date, ticker)
);

-- ─────────────────────────────────────────────────────────
-- 백테스트 결과
-- ─────────────────────────────────────────────────────────
CREATE TABLE backtest_results (
    strategy_id    VARCHAR(50) NOT NULL,
    date           DATE        NOT NULL,
    ticker         VARCHAR(10) NOT NULL,
    signal         VARCHAR(20),
    entry_price    INTEGER,
    exit_price     INTEGER,
    actual_return  FLOAT,
    hit            BOOLEAN,
    PRIMARY KEY (strategy_id, date, ticker)
);
CREATE INDEX backtest_results_strategy_date_idx ON backtest_results (strategy_id, date);

-- ─────────────────────────────────────────────────────────
-- RAG 청크
-- ─────────────────────────────────────────────────────────
CREATE TABLE rag_chunks (
    id                  VARCHAR(50) PRIMARY KEY,
    topic               TEXT        NOT NULL,
    markets             TEXT[],
    sectors             TEXT[],
    related_tickers     TEXT[],
    trigger_conditions  TEXT[],
    positive_signal     VARCHAR(20),
    risk_warning        TEXT,
    body                TEXT        NOT NULL,
    embedding           extensions.vector(1536),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX rag_chunks_embedding_idx ON rag_chunks USING ivfflat (embedding extensions.vector_cosine_ops) WITH (lists = 100);
CREATE INDEX rag_chunks_sectors_idx   ON rag_chunks USING gin (sectors);
CREATE INDEX rag_chunks_tickers_idx   ON rag_chunks USING gin (related_tickers);

-- ─────────────────────────────────────────────────────────
-- 알림 발송 로그
-- ─────────────────────────────────────────────────────────
CREATE TABLE notifications (
    id          SERIAL PRIMARY KEY,
    date        DATE        NOT NULL,
    channel     VARCHAR(20),                       -- 'telegram' | 'kakao'
    recipient   VARCHAR(100),
    payload     JSONB,
    status      VARCHAR(20),                       -- 'sent' | 'failed' | 'dry_run'
    error       TEXT,
    sent_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX notifications_date_idx ON notifications (date DESC);
