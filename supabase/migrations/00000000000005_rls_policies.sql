-- 00000000000005_rls_policies.sql
-- Row Level Security — SKILL.md 12-4번.
-- Service Role Key는 모든 RLS를 우회 (백엔드 워커용).
-- Anon Key 또는 인증된 JWT는 본 정책에 따름.

-- ═══════════════════════════════════════════════════════════
-- 1. 시장 데이터 — RLS enable, 인증 사용자만 read
-- ═══════════════════════════════════════════════════════════
ALTER TABLE stocks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE korea_market    ENABLE ROW LEVEL SECURITY;
ALTER TABLE global_market   ENABLE ROW LEVEL SECURITY;
ALTER TABLE news_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE filings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_scores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE rag_chunks      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications   ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_read_stocks         ON stocks         FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_korea_market   ON korea_market   FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_global_market  ON global_market  FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_news_items     ON news_items     FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_filings        ON filings        FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_ai_scores      ON ai_scores      FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_predictions    ON predictions    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_backtest_res   ON backtest_results FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_rag_chunks     ON rag_chunks     FOR SELECT TO authenticated USING (TRUE);
-- notifications 는 admin만 read (아래 별도 정의)

-- ═══════════════════════════════════════════════════════════
-- 2. mapping / weights — admin만 write, 인증 사용자 read
-- ═══════════════════════════════════════════════════════════
ALTER TABLE us_kr_mapping  ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_configs ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_read_mapping ON us_kr_mapping FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY admin_write_mapping ON us_kr_mapping FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY auth_read_weights ON weight_configs FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY admin_write_weights ON weight_configs FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- rag_chunks 는 admin만 write
CREATE POLICY admin_write_rag_chunks ON rag_chunks FOR ALL TO authenticated
    USING      (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- ═══════════════════════════════════════════════════════════
-- 3. 사용자 데이터 (profiles, watchlists, feedback, paper_*)
-- ═══════════════════════════════════════════════════════════
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_watchlists  ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_feedback    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invite_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_trades     ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_portfolio  ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_jobs    ENABLE ROW LEVEL SECURITY;

-- profiles
CREATE POLICY users_read_own_profile   ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY users_update_own_profile ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY admin_read_all_profiles  ON profiles FOR SELECT
    USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
CREATE POLICY admin_update_all_profiles ON profiles FOR UPDATE
    USING (EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));

-- user_watchlists
CREATE POLICY users_manage_own_watchlist ON user_watchlists FOR ALL
    USING      (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- user_feedback (본인 INSERT/SELECT, admin 전체 SELECT)
CREATE POLICY users_insert_own_feedback ON user_feedback FOR INSERT
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY users_read_own_feedback ON user_feedback FOR SELECT
    USING (auth.uid() = user_id);
CREATE POLICY admin_read_all_feedback ON user_feedback FOR SELECT
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- invite_codes (admin만 관리)
CREATE POLICY admin_manage_invites ON invite_codes FOR ALL
    USING      (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- paper_trades / paper_portfolio (본인만)
CREATE POLICY users_manage_own_trades    ON paper_trades    FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY users_manage_own_portfolio ON paper_portfolio FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- backtest_jobs (admin만 관리, 본인이 만든 것 read)
CREATE POLICY users_read_own_jobs ON backtest_jobs FOR SELECT USING (auth.uid() = created_by);
CREATE POLICY admin_manage_jobs   ON backtest_jobs FOR ALL
    USING      (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
    WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- notifications 는 admin만 read
CREATE POLICY admin_read_notifications ON notifications FOR SELECT
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- ═══════════════════════════════════════════════════════════
-- 4. audit_logs — admin만 read, 시스템(service_role)이 write
-- ═══════════════════════════════════════════════════════════
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_audit ON audit_logs FOR SELECT
    USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
-- INSERT 정책 없음 → service_role만 가능 (auth.uid() IS NULL이거나 RLS 우회)
