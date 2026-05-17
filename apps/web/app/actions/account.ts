'use server';

/**
 * Self-service account management actions.
 *
 *   updatePasswordAction — verify current password, then set new one
 *   updateEmailAction    — request email change (sends confirmation email)
 *   deleteAccountAction  — irreversible; requires password re-entry
 *
 * Each action runs server-side so admin Supabase credentials never leak
 * to the browser, and all sensitive state changes get written to
 * audit_logs.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const passwordRule = z
  .string()
  .min(12, '12자 이상 필요')
  .regex(/[A-Z]/, '대문자 포함 필요')
  .regex(/[a-z]/, '소문자 포함 필요')
  .regex(/[0-9]/, '숫자 포함 필요')
  .regex(/[^A-Za-z0-9]/, '특수문자 포함 필요');

// ── Password change ─────────────────────────────────────────────

const passwordSchema = z.object({
  currentPassword: z.string().min(1, '현재 비밀번호를 입력해주세요'),
  newPassword: passwordRule,
});

export async function updatePasswordAction(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok?: true; error?: string }> {
  const parsed = passwordSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? '입력값이 유효하지 않습니다' };
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return { error: '새 비밀번호가 현재 비밀번호와 같습니다' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: '로그인이 필요합니다' };

  // Re-authenticate with current password before allowing change.
  // Supabase doesn't have a native "verify password" RPC, so we
  // signInWithPassword as a probe — succeeds = correct password.
  const { error: signinErr } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (signinErr) {
    return { error: '현재 비밀번호가 올바르지 않습니다' };
  }

  const { error: updateErr } = await supabase.auth.updateUser({
    password: parsed.data.newPassword,
  });
  if (updateErr) {
    return { error: `비밀번호 변경 실패: ${updateErr.message}` };
  }

  // Audit log via service_role (RLS bypass).
  const admin = createAdminClient();
  await admin.from('audit_logs').insert({
    user_id: user.id,
    action: 'account.password_change',
    resource_type: 'auth.users',
    resource_id: user.id,
    changes: { changed_at: new Date().toISOString() },
  });

  revalidatePath('/settings');
  return { ok: true };
}

// ── Email change ────────────────────────────────────────────────

const emailSchema = z.object({
  newEmail: z.string().email('올바른 이메일을 입력해주세요'),
});

export async function updateEmailAction(input: {
  newEmail: string;
}): Promise<{ ok?: true; error?: string; message?: string }> {
  const parsed = emailSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? '입력값이 유효하지 않습니다' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다' };

  if (user.email === parsed.data.newEmail) {
    return { error: '현재 이메일과 동일합니다' };
  }

  // Supabase sends a confirmation email to the NEW address; the change
  // only takes effect after the user clicks the link.
  const { error } = await supabase.auth.updateUser({ email: parsed.data.newEmail });
  if (error) {
    return { error: `이메일 변경 실패: ${error.message}` };
  }

  const admin = createAdminClient();
  await admin.from('audit_logs').insert({
    user_id: user.id,
    action: 'account.email_change_requested',
    resource_type: 'auth.users',
    resource_id: user.id,
    changes: { from: user.email, to: parsed.data.newEmail },
  });

  return {
    ok: true,
    message: `${parsed.data.newEmail} 로 확인 메일을 발송했습니다. 메일의 링크를 클릭해야 변경이 완료됩니다.`,
  };
}

// ── Account deletion ────────────────────────────────────────────

const deleteSchema = z.object({
  currentPassword: z.string().min(1, '현재 비밀번호를 입력해주세요'),
  confirmText: z.string(),
});

/**
 * Delete the caller's auth.users + profile row.
 *
 * Why service_role: auth.admin.deleteUser requires service_role; the
 * regular client API doesn't expose self-delete. We re-authenticate
 * with the password first so a hijacked session can't nuke the
 * account silently.
 */
export async function deleteAccountAction(input: {
  currentPassword: string;
  confirmText: string;
}): Promise<{ error?: string }> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? '입력값이 유효하지 않습니다' };
  }
  if (parsed.data.confirmText !== '계정 삭제') {
    return { error: '"계정 삭제"를 정확히 입력해주세요' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return { error: '로그인이 필요합니다' };

  const { error: signinErr } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: parsed.data.currentPassword,
  });
  if (signinErr) {
    return { error: '현재 비밀번호가 올바르지 않습니다' };
  }

  const admin = createAdminClient();

  // Audit BEFORE delete so the row survives.
  await admin.from('audit_logs').insert({
    user_id: user.id,
    action: 'account.delete',
    resource_type: 'auth.users',
    resource_id: user.id,
    changes: { email: user.email, deleted_at: new Date().toISOString() },
  });

  // Cascading FKs on profiles/user_watchlists/etc. clean up the rest.
  const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);
  if (deleteErr) {
    return { error: `계정 삭제 실패: ${deleteErr.message}` };
  }

  // Clear the session cookie on the server side, then redirect.
  await supabase.auth.signOut();
  redirect('/login?deleted=1');
}
