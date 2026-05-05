'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { randomBytes } from 'crypto';

import { getAdminWriteClient, recordAudit } from '@/lib/audit';

function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
  const bytes = randomBytes(12);
  return Array.from(bytes).map((b) => alphabet[b % alphabet.length]).join('');
}

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'beta', 'user']).default('beta'),
});

export async function createInvite(
  raw: z.infer<typeof inviteSchema>,
): Promise<{ ok?: true; code?: string; invite_url?: string; email_sent?: boolean; error?: string; warning?: string }> {
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const code = generateInviteCode();
  const expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();

  const { error } = await sb.from('invite_codes').insert({
    code,
    email: parsed.data.email,
    role: parsed.data.role,
    expires_at,
  });
  if (error) return { error: error.message };

  const siteUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const invite_url = `${siteUrl}/invite/${code}`;

  let email_sent = false;
  let warning: string | undefined;
  try {
    await sb.auth.admin.inviteUserByEmail(parsed.data.email, { redirectTo: invite_url });
    email_sent = true;
  } catch (exc) {
    warning = `이메일 발송 실패 — 링크를 직접 공유: ${(exc as Error).message}`;
  }

  await recordAudit({
    action: 'user.invite',
    resource_type: 'invite_codes',
    resource_id: code,
    changes: { email: parsed.data.email, role: parsed.data.role },
  });

  revalidatePath('/admin/users');
  return { ok: true, code, invite_url, email_sent, warning };
}

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
