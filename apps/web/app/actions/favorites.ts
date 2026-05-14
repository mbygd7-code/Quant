'use server';

/**
 * Personal 관심주식 server-side store.
 *
 * Client components keep an in-browser localStorage cache for instant UX
 * (`lib/use-favorites.ts`), then call these actions to mirror the set to
 * the DB so the cycle orchestrator can read it. The two paths are eventually
 * consistent — a localStorage write that hasn't reached the server yet
 * just delays inclusion in the next cron, not user-facing behaviour.
 *
 * DEV_BYPASS_AUTH uses the literal 'dev-bypass' user_id sentinel so local
 * dev can write without a real Supabase auth session.
 */
import { revalidatePath } from 'next/cache';

import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH, getAdminClient } from '@/lib/supabase/query-client';
import { KR_TICKER_RE } from '@/lib/ticker';

async function resolveUserId(): Promise<string | null> {
  if (DEV_BYPASS_AUTH) return 'dev-bypass';
  const sb = await createClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  return user?.id ?? null;
}

/** Replace the entire favorites set for the current user. Used by the
 *  one-shot sync that bulk-uploads localStorage on hydration. */
export async function syncFavoritesAction(
  tickers: string[],
): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  const userId = await resolveUserId();
  if (!userId) return { ok: false, error: '로그인이 필요합니다.' };

  // Validate up-front so a single bad ticker doesn't poison the batch.
  const clean = Array.from(
    new Set(
      tickers
        .map((t) => t.trim().toUpperCase())
        .filter((t) => KR_TICKER_RE.test(t)),
    ),
  );
  if (clean.length > 100) {
    return { ok: false, error: '관심주식은 최대 100종목까지 추가할 수 있습니다.' };
  }

  // Service-role write so we don't fight RLS for the dev-bypass sentinel.
  const admin = getAdminClient();

  // Two-step: delete missing then upsert kept. Cheaper than diffing client-side.
  const { data: existing } = await admin
    .from('user_favorites')
    .select('ticker')
    .eq('user_id', userId);
  const existingSet = new Set((existing ?? []).map((r) => r.ticker as string));
  const incomingSet = new Set(clean);

  const toDelete = Array.from(existingSet).filter((t) => !incomingSet.has(t));
  const toInsert = clean.filter((t) => !existingSet.has(t));

  if (toDelete.length > 0) {
    const { error } = await admin
      .from('user_favorites')
      .delete()
      .eq('user_id', userId)
      .in('ticker', toDelete);
    if (error) return { ok: false, error: `delete: ${error.message}` };
  }
  if (toInsert.length > 0) {
    const rows = toInsert.map((ticker) => ({ user_id: userId, ticker }));
    const { error } = await admin.from('user_favorites').insert(rows);
    if (error) return { ok: false, error: `insert: ${error.message}` };
  }

  revalidatePath('/favorites');
  return { ok: true, count: clean.length };
}

/** Add a single ticker. Used by the LNB picker `+ 추가` button. */
export async function addFavoriteAction(
  ticker: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await resolveUserId();
  if (!userId) return { ok: false, error: '로그인이 필요합니다.' };

  const t = ticker.trim().toUpperCase();
  if (!KR_TICKER_RE.test(t)) return { ok: false, error: '잘못된 티커' };

  const admin = getAdminClient();
  const { error } = await admin
    .from('user_favorites')
    .upsert(
      { user_id: userId, ticker: t },
      { onConflict: 'user_id,ticker', ignoreDuplicates: true },
    );
  if (error) return { ok: false, error: error.message };

  revalidatePath('/favorites');
  return { ok: true };
}

/** Remove a single ticker. Used by LNB row × button + /watchlist ★ toggle. */
export async function removeFavoriteAction(
  ticker: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = await resolveUserId();
  if (!userId) return { ok: false, error: '로그인이 필요합니다.' };

  const t = ticker.trim().toUpperCase();
  const admin = getAdminClient();
  const { error } = await admin
    .from('user_favorites')
    .delete()
    .eq('user_id', userId)
    .eq('ticker', t);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/favorites');
  return { ok: true };
}

/** Read favorites for the current user — used by /favorites page server
 *  component to seed initial state without waiting for client hydration. */
export async function listMyFavoritesAction(): Promise<string[]> {
  const userId = await resolveUserId();
  if (!userId) return [];
  const admin = getAdminClient();
  const { data } = await admin
    .from('user_favorites')
    .select('ticker, added_at')
    .eq('user_id', userId)
    .order('added_at', { ascending: true });
  return (data ?? []).map((r) => r.ticker as string);
}
