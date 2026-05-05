'use server';

import { revalidatePath } from 'next/cache';
import { recordAudit } from '@/lib/audit';

export async function sendPreviewNow(): Promise<{ ok?: true; error?: string; sent?: number; failed?: number }> {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api';
  // In dev (Next on 4062, FastAPI on 8000) the relative /api won't reach FastAPI.
  // Fall back to absolute URL when API_INTERNAL_URL is set.
  const apiInternal = process.env.API_INTERNAL_URL ?? null;
  const url = apiInternal
    ? `${apiInternal}/api/notifications/send-now`
    : `${apiBase}/notifications/send-now`;

  try {
    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text()}` };
    const data = await res.json() as { sent?: number; failed?: number };
    await recordAudit({
      action: 'notifications.send_now',
      resource_type: 'notifications',
      changes: data as Record<string, unknown>,
    });
    revalidatePath('/admin/notifications');
    return { ok: true, sent: data.sent, failed: data.failed };
  } catch (exc) {
    return { error: `요청 실패: ${(exc as Error).message}. apps/api 서버가 실행 중인지 확인하세요.` };
  }
}
