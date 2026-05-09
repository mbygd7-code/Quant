import { createClient } from '@supabase/supabase-js';

/**
 * service_role 키 기반 관리자 클라이언트.
 * 서버 전용. NEVER import from client components.
 * 현재 사용처: dev-only 빠른 로그인 (apps/web/app/api/dev-login).
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    throw new Error(
      'Supabase admin client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }

  return createClient(url, serviceRole, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
