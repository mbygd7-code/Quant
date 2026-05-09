-- 00000000000021_agent_knowledge.sql
-- Long-term memory for the 8-agent system. Schema only — population
-- starts in M8 (강화 학습 활성화).
--
-- Each row is a "lesson" an agent draws from observing how its past
-- decisions played out. Rows accrue over months; M8's growth dashboards
-- aggregate this table to show 캐릭터별 적중률 시계열.
--
-- knowledge_type:
--   'lesson'        — generalizable rule learned from outcome
--   'pattern'       — recurring market pattern the agent now recognizes
--   'self_critique' — agent's own admission of where it was wrong
--
-- We keep this lightweight on purpose. Embeddings (for retrieval) and
-- consolidation logic (merging duplicate lessons) come in M8.

CREATE TABLE IF NOT EXISTS agent_knowledge (
    id                  UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    agent_name          TEXT NOT NULL,
    knowledge_type      TEXT NOT NULL,
    content_md          TEXT NOT NULL,                        -- markdown, Korean
    source_signal_id    UUID REFERENCES final_signals(id) ON DELETE SET NULL,
    confidence_at_time  NUMERIC(3, 2),                        -- the agent's confidence when the source signal fired
    outcome_observed    TEXT,                                 -- 'correct' | 'incorrect' | 'partial' | 'pending' (free text for M1, M8 will normalize)
    outcome_horizon_d   SMALLINT,                             -- how many days after signal the outcome was scored (typically 7 / 30 / 90)
    realized_return     NUMERIC(6, 4),                        -- e.g., +0.0834 for +8.34% over horizon (NULL for non-numeric outcomes)
    tags                TEXT[],                               -- e.g., {'macro_shock','korean_won_weakness'} for filtering
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT agent_knowledge_agent_chk
        CHECK (agent_name IN ('soros','taleb','simons','graham','dow','shiller','keynes','turing')),
    CONSTRAINT agent_knowledge_type_chk
        CHECK (knowledge_type IN ('lesson','pattern','self_critique')),
    CONSTRAINT agent_knowledge_confidence_chk
        CHECK (confidence_at_time IS NULL OR (confidence_at_time >= 0 AND confidence_at_time <= 1)),
    CONSTRAINT agent_knowledge_horizon_chk
        CHECK (outcome_horizon_d IS NULL OR outcome_horizon_d > 0)
);

CREATE INDEX IF NOT EXISTS agent_knowledge_agent_created_idx
    ON agent_knowledge (agent_name, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_knowledge_tags_gin_idx
    ON agent_knowledge USING GIN (tags);
-- Source-signal lookup is expected (e.g., "what did agents learn from
-- this trade?"), but volume is low enough that a btree on FK is fine.
CREATE INDEX IF NOT EXISTS agent_knowledge_source_signal_idx
    ON agent_knowledge (source_signal_id) WHERE source_signal_id IS NOT NULL;

-- RLS — read for all authenticated; writes service_role only.
-- M8 self-reflection cron writes lessons; users only read.
ALTER TABLE agent_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_read_agent_knowledge ON agent_knowledge
    FOR SELECT TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
