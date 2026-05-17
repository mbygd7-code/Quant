'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getAdminWriteClient, recordAudit } from '@/lib/audit';

const roleSchema = z.object({ role: z.enum(['admin', 'beta', 'user']) });

export async function updateUserRole(
  userId: string,
  raw: z.infer<typeof roleSchema>,
): Promise<{ ok?: true; error?: string }> {
  const parsed = roleSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const { data: before } = await sb.from('profiles').select('email, role').eq('id', userId).maybeSingle();
  const { error } = await sb.from('profiles').update({ role: parsed.data.role }).eq('id', userId);
  if (error) return { error: error.message };

  await recordAudit({
    action: 'user.role_change',
    resource_type: 'profiles',
    resource_id: userId,
    changes: { before: before, after: { role: parsed.data.role } },
  });
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function disconnectUserTelegram(userId: string): Promise<{ ok?: true; error?: string }> {
  const sb = getAdminWriteClient();
  const { error } = await sb
    .from('profiles')
    .update({ telegram_chat_id: null, telegram_link_code: null, link_code_expires_at: null })
    .eq('id', userId);
  if (error) return { error: error.message };
  await recordAudit({
    action: 'user.disconnect_telegram',
    resource_type: 'profiles',
    resource_id: userId,
  });
  revalidatePath('/admin/users');
  return { ok: true };
}

// ── Approval queue actions ──────────────────────────────────────
// All three live behind /admin/users, so the route's admin middleware
// is what gates them. We still record every action to audit_logs.

const approveSchema = z.object({
  role: z.enum(['user', 'beta']),
  note: z.string().max(500).optional(),
});

export async function approveUser(
  userId: string,
  raw: z.infer<typeof approveSchema>,
): Promise<{ ok?: true; error?: string }> {
  const parsed = approveSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const { data: before } = await sb
    .from('profiles')
    .select('email, role, approval_status')
    .eq('id', userId)
    .maybeSingle();

  const { error } = await sb
    .from('profiles')
    .update({
      role: parsed.data.role,
      approval_status: 'approved',
      approval_note: parsed.data.note ?? null,
      approved_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) return { error: error.message };

  await recordAudit({
    action: 'user.approve',
    resource_type: 'profiles',
    resource_id: userId,
    changes: { before, after: { role: parsed.data.role, approval_status: 'approved' } },
  });
  revalidatePath('/admin/users');
  return { ok: true };
}

const rejectSchema = z.object({
  note: z.string().min(1, '거절 사유는 필수입니다').max(500),
});

export async function rejectUser(
  userId: string,
  raw: z.infer<typeof rejectSchema>,
): Promise<{ ok?: true; error?: string }> {
  const parsed = rejectSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const { data: before } = await sb
    .from('profiles')
    .select('email, approval_status')
    .eq('id', userId)
    .maybeSingle();

  const { error } = await sb
    .from('profiles')
    .update({
      approval_status: 'rejected',
      approval_note: parsed.data.note,
      approved_at: new Date().toISOString(),
    })
    .eq('id', userId);
  if (error) return { error: error.message };

  await recordAudit({
    action: 'user.reject',
    resource_type: 'profiles',
    resource_id: userId,
    changes: { before, after: { approval_status: 'rejected', note: parsed.data.note } },
  });
  revalidatePath('/admin/users');
  return { ok: true };
}

/**
 * Extend the 5-business-day SLA for a pending account by resetting
 * its `reapplied_at` (which the expiry job uses as the clock origin
 * when set, falling back to created_at otherwise). Useful when the
 * admin needs more time but the user shouldn't have to reapply.
 */
export async function extendApprovalSla(userId: string): Promise<{ ok?: true; error?: string }> {
  const sb = getAdminWriteClient();
  const { error } = await sb
    .from('profiles')
    .update({ reapplied_at: new Date().toISOString() })
    .eq('id', userId)
    .eq('approval_status', 'pending');
  if (error) return { error: error.message };

  await recordAudit({
    action: 'user.extend_sla',
    resource_type: 'profiles',
    resource_id: userId,
  });
  revalidatePath('/admin/users');
  return { ok: true };
}

export async function deleteUser(userId: string): Promise<{ ok?: true; error?: string }> {
  const sb = getAdminWriteClient();
  const { data: before } = await sb.from('profiles').select('email, role').eq('id', userId).maybeSingle();
  try {
    await sb.auth.admin.deleteUser(userId);
  } catch (exc) {
    return { error: `Auth 삭제 실패: ${(exc as Error).message}` };
  }
  await recordAudit({
    action: 'user.delete',
    resource_type: 'profiles',
    resource_id: userId,
    changes: { before },
  });
  revalidatePath('/admin/users');
  return { ok: true };
}
