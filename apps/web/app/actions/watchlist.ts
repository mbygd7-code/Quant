'use server';

import { createClient } from '@/lib/supabase/server';
import { getAdminWriteClient, recordAudit } from '@/lib/audit';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { ROLE_WATCHLIST_LIMIT, type Role } from '@/lib/types';
import { searchAvailableStocks } from '@/lib/queries/watchlist';

export async function searchStocksAction(query: string) {
  return await searchAvailableStocks(query);
}

/**
 * Admin-only: search KR stocks that are currently NOT on the master
 * watchlist. Used by /watchlist's admin "+ 추가" dialog.
 */
export async function searchUnaddedKrStocksAction(query: string) {
  const sb = getAdminWriteClient();
  const trimmed = query.trim();
  let q = sb
    .from('stocks')
    .select('ticker, name, sector, market')
    .eq('is_watchlist', false)
    .in('market', ['KOSPI', 'KOSDAQ'])
    .limit(20);
  if (trimmed.length > 0) {
    q = q.or(`ticker.ilike.%${trimmed}%,name.ilike.%${trimmed}%`);
  }
  const { data } = await q;
  return data ?? [];
}

/**
 * Admin-only: flip stocks.is_watchlist to true. Idempotent.
 */
export async function adminAddToWatchlist(
  ticker: string,
): Promise<{ ok?: true; error?: string }> {
  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { error: '로그인이 필요합니다' };
    const { data: profile } = await sb
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile?.role !== 'admin') return { error: 'admin 권한 필요' };
  }
  const sb = getAdminWriteClient();
  const { data: before } = await sb
    .from('stocks').select('ticker, name, is_watchlist').eq('ticker', ticker).maybeSingle();
  if (!before) return { error: `종목 ${ticker} 이 stocks 테이블에 없습니다` };
  const { error } = await sb
    .from('stocks').update({ is_watchlist: true }).eq('ticker', ticker);
  if (error) return { error: error.message };
  await recordAudit({
    action: 'watchlist.add',
    resource_type: 'stocks',
    resource_id: ticker,
    changes: { before, after: { is_watchlist: true } },
  });
  return { ok: true };
}

/**
 * Admin-only: flip stocks.is_watchlist to false. Doesn't delete the
 * stocks row — historical ai_scores / korea_market keep their FKs.
 */
export async function adminRemoveFromWatchlist(
  ticker: string,
): Promise<{ ok?: true; error?: string }> {
  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { error: '로그인이 필요합니다' };
    const { data: profile } = await sb
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    if (profile?.role !== 'admin') return { error: 'admin 권한 필요' };
  }
  const sb = getAdminWriteClient();
  const { data: before } = await sb
    .from('stocks').select('ticker, name, is_watchlist').eq('ticker', ticker).maybeSingle();
  const { error } = await sb
    .from('stocks').update({ is_watchlist: false }).eq('ticker', ticker);
  if (error) return { error: error.message };
  await recordAudit({
    action: 'watchlist.remove',
    resource_type: 'stocks',
    resource_id: ticker,
    changes: { before, after: { is_watchlist: false } },
  });
  return { ok: true };
}

export async function addStockToWatchlist(
  ticker: string,
): Promise<{ ok?: true; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다' };

  const { data: profile } = await sb
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  const role = ((profile?.role as Role) ?? 'user') as Role;

  if (role === 'admin') {
    // admin은 stocks(is_watchlist=true)을 직접 사용 — user_watchlists 추가 불가
    return { error: 'admin은 종목 마스터(stocks 테이블)에서 관리합니다' };
  }

  const { count } = await sb
    .from('user_watchlists')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id);
  const limit = ROLE_WATCHLIST_LIMIT[role];
  if ((count ?? 0) >= limit) {
    return { error: `종목 한도(${limit}개)에 도달했습니다` };
  }

  const { error } = await sb
    .from('user_watchlists')
    .insert({ user_id: user.id, ticker });
  if (error) return { error: error.message };

  return { ok: true };
}

export async function removeStockFromWatchlist(
  ticker: string,
): Promise<{ ok?: true; error?: string }> {
  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { error: '로그인이 필요합니다' };

  const { error } = await sb
    .from('user_watchlists')
    .delete()
    .eq('user_id', user.id)
    .eq('ticker', ticker);
  if (error) return { error: error.message };

  return { ok: true };
}
