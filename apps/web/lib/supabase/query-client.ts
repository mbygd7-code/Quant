// Server-side Supabase client used for read queries from Server Components.
//
// Normal mode: returns the cookie-bound client (SSR auth, RLS enforced).
// DEV bypass: when DEV_BYPASS_AUTH=true, returns a service-role client that
// ignores RLS so the UI can render without login. Dev-only escape hatch —
// never enable in production.
import { createClient as createCookieClient } from '@/lib/supabase/server';
import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

export const DEV_BYPASS_AUTH = process.env.DEV_BYPASS_AUTH === 'true';

let _adminSingleton: SupabaseClient | null = null;

function getAdminClient(): SupabaseClient {
  if (_adminSingleton) return _adminSingleton;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!serviceKey) {
    throw new Error('DEV_BYPASS_AUTH=true requires SUPABASE_SERVICE_ROLE_KEY');
  }
  _adminSingleton = createSupabaseClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Bypass Next.js fetch cache so Server Components always read fresh
      // data from Supabase. Without this, scorer reruns or pipeline updates
      // don't show up until the next dev-server restart.
      fetch: (input, init) =>
        fetch(input as RequestInfo, { ...init, cache: 'no-store' }),
    },
  });
  return _adminSingleton;
}

/** Use for read-only queries from Server Components. Honors DEV_BYPASS_AUTH. */
export async function getQueryClient(): Promise<SupabaseClient> {
  if (DEV_BYPASS_AUTH) return getAdminClient();
  return await createCookieClient();
}
