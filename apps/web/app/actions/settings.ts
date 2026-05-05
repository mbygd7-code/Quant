'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

function generateLinkCode(): string {
  // 6 digits, zero-padded
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function generateTelegramLinkCode(): Promise<{
  code?: string;
  expiresAt?: string;
  error?: string;
}> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다' };

  const code = generateLinkCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error } = await sb
    .from('profiles')
    .update({
      telegram_link_code: code,
      link_code_expires_at: expiresAt,
    })
    .eq('id', user.id);

  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { code, expiresAt };
}

export async function disconnectTelegram(): Promise<{ ok?: true; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다' };

  const { error } = await sb
    .from('profiles')
    .update({
      telegram_chat_id: null,
      telegram_link_code: null,
      link_code_expires_at: null,
    })
    .eq('id', user.id);
  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}

export async function setNotificationEnabled(
  enabled: boolean,
): Promise<{ ok?: true; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다' };

  const { error } = await sb
    .from('profiles')
    .update({ notification_enabled: enabled })
    .eq('id', user.id);
  if (error) return { error: error.message };

  revalidatePath('/settings');
  return { ok: true };
}
