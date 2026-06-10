-- 00000000000032_rls_admin_recursion_fix.sql
-- (renumbered from 29 — the duplicate version 29 broke `supabase db push`
--  with "duplicate key value violates unique constraint schema_migrations_pkey"
--  from 2026-05-30, silently blocking migrations 30+. Content is idempotent
--  (DROP POLICY IF EXISTS + CREATE), so re-applying is safe.)
-- Replace recursive `EXISTS (SELECT 1 FROM profiles ... role = 'admin')`
-- admin checks in migration 05 with the existing public.is_admin()
-- SECURITY DEFINER helper (migration 22). The recursive pattern caused
-- `infinite recursion detected in policy for relation "profiles"` on any
-- authenticated query touching profiles or rag_chunks (and every other
-- table guarded by the same pattern).
--
-- Same authorisation outcome — only the evaluation path changes.

-- ─── profiles ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_read_all_profiles   ON profiles;
DROP POLICY IF EXISTS admin_update_all_profiles ON profiles;

CREATE POLICY admin_read_all_profiles ON profiles
    FOR SELECT TO authenticated
    USING (public.is_admin());

CREATE POLICY admin_update_all_profiles ON profiles
    FOR UPDATE TO authenticated
    USING (public.is_admin());

-- ─── us_kr_mapping ─────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_write_mapping ON us_kr_mapping;

CREATE POLICY admin_write_mapping ON us_kr_mapping
    FOR ALL TO authenticated
    USING      (public.is_admin())
    WITH CHECK (public.is_admin());

-- ─── weight_configs ────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_write_weights ON weight_configs;

CREATE POLICY admin_write_weights ON weight_configs
    FOR ALL TO authenticated
    USING      (public.is_admin())
    WITH CHECK (public.is_admin());

-- ─── rag_chunks ────────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_write_rag_chunks ON rag_chunks;

CREATE POLICY admin_write_rag_chunks ON rag_chunks
    FOR ALL TO authenticated
    USING      (public.is_admin())
    WITH CHECK (public.is_admin());

-- ─── user_feedback ─────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_read_all_feedback ON user_feedback;

CREATE POLICY admin_read_all_feedback ON user_feedback
    FOR SELECT TO authenticated
    USING (public.is_admin());

-- ─── invite_codes ──────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_manage_invites ON invite_codes;

CREATE POLICY admin_manage_invites ON invite_codes
    FOR ALL TO authenticated
    USING      (public.is_admin())
    WITH CHECK (public.is_admin());

-- ─── backtest_jobs ─────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_manage_jobs ON backtest_jobs;

CREATE POLICY admin_manage_jobs ON backtest_jobs
    FOR ALL TO authenticated
    USING      (public.is_admin())
    WITH CHECK (public.is_admin());

-- ─── notifications ─────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_read_notifications ON notifications;

CREATE POLICY admin_read_notifications ON notifications
    FOR SELECT TO authenticated
    USING (public.is_admin());

-- ─── audit_logs ────────────────────────────────────────────────────
DROP POLICY IF EXISTS admin_read_audit ON audit_logs;

CREATE POLICY admin_read_audit ON audit_logs
    FOR SELECT TO authenticated
    USING (public.is_admin());
