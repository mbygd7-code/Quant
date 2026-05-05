'use server';

import { createClient } from '@/lib/supabase/server';
import { ROLE_WATCHLIST_LIMIT, type Role } from '@/lib/types';
import { searchAvailableStocks } from '@/lib/queries/watchlist';

export async function searchStocksAction(query: string) {
  return await searchAvailableStocks(query);
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
