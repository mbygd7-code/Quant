-- 00000000000004_user_tables.sql
-- 웹앱용 — 프로필/관심종목/초대/피드백/가중치/감사로그.

-- ─────────────────────────────────────────────────────────
-- 사용자 프로필 (auth.users 확장)
-- ─────────────────────────────────────────────────────────
CREATE TABLE profiles (
    id                    UUID         PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email                 VARCHAR(255) NOT NULL,
    display_name          VARCHAR(100),
    role                  VARCHAR(20)  NOT NULL CHECK (role IN ('admin', 'beta', 'user')),
    telegram_chat_id      VARCHAR(50),
    telegram_link_code    VARCHAR(10),
    link_code_expires_at  TIMESTAMPTZ,
    notification_enabled  BOOLEAN      DEFAULT TRUE,
    notification_time     TIME         DEFAULT '06:30',
    created_at            TIMESTAMPTZ  DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX profiles_telegram_idx ON profiles (telegram_chat_id);
CREATE INDEX profiles_role_idx     ON profiles (role);

-- ─────────────────────────────────────────────────────────
-- 사용자별 관심종목 (3단계 권한별 제한)
-- ─────────────────────────────────────────────────────────
CREATE TABLE user_watchlists (
    id        UUID        PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id   UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    ticker    VARCHAR(10) NOT NULL,
    added_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (user_id, ticker)
);
CREATE INDEX user_watchlists_user_idx ON user_watchlists (user_id);

-- ─────────────────────────────────────────────────────────
-- beta 초대 코드
-- ─────────────────────────────────────────────────────────
CREATE TABLE invite_codes (
    code        VARCHAR(20)  PRIMARY KEY,
    email       VARCHAR(255) NOT NULL,
    role        VARCHAR(20)  NOT NULL DEFAULT 'beta',
    created_by  UUID         REFERENCES profiles(id),
    expires_at  TIMESTAMPTZ  NOT NULL,
    used_at     TIMESTAMPTZ,
    used_by     UUID         REFERENCES profiles(id),
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────
-- 사용자 피드백
-- ─────────────────────────────────────────────────────────
CREATE TABLE user_feedback (
    id                UUID         PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id           UUID         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    date              DATE         NOT NULL,
    ticker            VARCHAR(10),
    accuracy_score    INTEGER      CHECK (accuracy_score BETWEEN 1 AND 5),
    usefulness_score  INTEGER      CHECK (usefulness_score BETWEEN 1 AND 5),
    comment           TEXT,
    source            VARCHAR(20),                        -- 'web' | 'telegram'
    created_at        TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX user_feedback_date_idx ON user_feedback (date DESC);

-- ─────────────────────────────────────────────────────────
-- 가중치 설정 버전 관리 (admin이 조정 시 히스토리)
-- ─────────────────────────────────────────────────────────
CREATE TABLE weight_configs (
    id                          UUID         PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    version                     VARCHAR(20)  NOT NULL,
    global_market_weight        FLOAT        NOT NULL DEFAULT 0.20,
    sector_weight               FLOAT        NOT NULL DEFAULT 0.20,
    related_us_stock_weight     FLOAT        NOT NULL DEFAULT 0.20,
    news_sentiment_weight       FLOAT        NOT NULL DEFAULT 0.15,
    fundamental_weight          FLOAT        NOT NULL DEFAULT 0.10,
    volume_flow_weight          FLOAT        NOT NULL DEFAULT 0.10,
    risk_penalty_weight         FLOAT        NOT NULL DEFAULT 0.05,
    signal_threshold_strong     FLOAT        NOT NULL DEFAULT 0.80,
    signal_threshold_interest   FLOAT        NOT NULL DEFAULT 0.65,
    signal_threshold_neutral    FLOAT        NOT NULL DEFAULT 0.50,
    signal_threshold_caution    FLOAT        NOT NULL DEFAULT 0.35,
    is_active                   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_by                  UUID         REFERENCES profiles(id),
    created_at                  TIMESTAMPTZ  DEFAULT NOW(),
    notes                       TEXT
);
CREATE UNIQUE INDEX one_active_weight_config ON weight_configs (is_active) WHERE is_active = TRUE;

-- ─────────────────────────────────────────────────────────
-- 감사 로그 (admin 편집 행위 기록)
-- ─────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
    id              UUID         PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id         UUID         REFERENCES profiles(id),
    action          VARCHAR(50)  NOT NULL,                -- 'mapping.update' | 'rag_chunk.create' ...
    resource_type   VARCHAR(50),
    resource_id     VARCHAR(100),
    changes         JSONB,                                -- {before: {...}, after: {...}}
    ip_address      INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);
CREATE INDEX audit_logs_user_idx       ON audit_logs (user_id);
CREATE INDEX audit_logs_action_idx     ON audit_logs (action);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);
