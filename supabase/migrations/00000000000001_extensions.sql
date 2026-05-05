-- 00000000000001_extensions.sql
-- Required extensions for QuantSignal.
-- Note: Supabase Dashboard → Database → Extensions 에서 'vector'를 한 번 활성화 승인해야
-- 이 마이그레이션이 통과합니다 (보안 정책).

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
