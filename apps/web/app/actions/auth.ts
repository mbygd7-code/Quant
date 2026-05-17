'use server';

/**
 * Auth-related server actions.
 *
 * Only the actions that need server privileges (or audit trails) live
 * here. Routine sign-in/sign-up still go through the Supabase JS
 * client because they need to set the user's session cookies.
 *
 * Currently exposes:
 *   - reapplyAction(): a previously rejected/expired user re-enters
 *     the admin approval queue.
 *   - signOutAction(): server-side sign-out so redirects work
 *     correctly from server-rendered pages like /pending.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function reapplyAction(): Promise<{
  ok?: true;
  error?: string;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다.' };

  // service_role bypasses the RLS recursion on profiles (see middleware.ts).
  const admin = createAdminClient();
  const { data: profile, error: readErr } = await admin
    .from('profiles')
    .select('approval_status, reapply_count')
    .eq('id', user.id)
    .maybeSingle();
  if (readErr || !profile) {
    return { error: '계정 정보를 불러올 수 없습니다.' };
  }

  // Only meaningful for terminal states.
  if (profile.approval_status === 'approved') {
    return { error: '이미 승인된 계정입니다.' };
  }
  if (profile.approval_status === 'pending') {
    return { error: '이미 승인 대기 중입니다.' };
  }

  const { error: updateErr } = await admin
    .from('profiles')
    .update({
      approval_status: 'pending',
      approval_note: null,
      approved_at: null,
      approved_by: null,
      reapplied_at: new Date().toISOString(),
      reapply_count: (profile.reapply_count ?? 0) + 1,
    })
    .eq('id', user.id);
  if (updateErr) return { error: updateErr.message };

  // Audit log — admin can see who reapplied and how often.
  await admin.from('audit_logs').insert({
    user_id: user.id,
    action: 'account.reapply',
    resource_type: 'profiles',
    resource_id: user.id,
    changes: {
      from: profile.approval_status,
      to: 'pending',
      reapply_count: (profile.reapply_count ?? 0) + 1,
    },
  });

  revalidatePath('/pending');
  return { ok: true };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
