// audit_logs helper — record admin edits.
// In DEV_BYPASS_AUTH mode the user_id FK to profiles can't be satisfied,
// so we skip the insert and log to console instead.
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { createClient } from '@/lib/supabase/server';

interface AuditEntry {
  action: string;
  resource_type?: string;
  resource_id?: string;
  changes?: Record<string, unknown>;
}

function adminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  if (DEV_BYPASS_AUTH) {
    console.info('[audit:DEV_BYPASS]', entry);
    return;
  }
  try {
    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    const admin = adminClient();
    await admin.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action: entry.action,
      resource_type: entry.resource_type ?? null,
      resource_id: entry.resource_id ?? null,
      changes: entry.changes ?? null,
    });
  } catch (exc) {
    console.warn('[audit] insert failed (non-fatal):', exc);
  }
}

/** Server-side admin Supabase client (bypasses RLS). Use for write operations. */
export function getAdminWriteClient() {
  return adminClient();
}
