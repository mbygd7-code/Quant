'use server';

import { createClient } from '@/lib/supabase/server';
import { getAdminWriteClient, recordAudit } from '@/lib/audit';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { ROLE_WATCHLIST_LIMIT, type Role } from '@/lib/types';
import { searchAvailableStocks } from '@/lib/queries/watchlist';

export async function searchStocksAction(query: string) {
  return await searchAvailableStocks(query);
}

export type DiscoveryMarket = 'ALL' | 'KOSPI' | 'KOSDAQ';
export type DiscoveryMode = 'popular' | 'gainers' | 'ai_pick' | 'foreign_buy';

export interface DiscoveryStock {
  ticker: string;
  name: string;
  sector: string | null;
  market: string;
  close: number | null;
  change_rate: number | null;
  volume: number | null;
  trading_value: number | null;
  foreign_net_buy: number | null;
  final_score: number | null;
  signal: string | null;
  // Per-mode highlight metric (used by UI for the right-side label)
  highlight: string | null;
}

/**
 * Admin-only: search KR stocks that are currently NOT on the master
 * watchlist. Used by /watchlist's admin "+ 추가" dialog.
 */
export async function searchUnaddedKrStocksAction(
  query: string,
  market: DiscoveryMarket = 'ALL',
) {
  const sb = getAdminWriteClient();
  const trimmed = query.trim();
  const markets = market === 'ALL' ? ['KOSPI', 'KOSDAQ'] : [market];
  let q = sb
    .from('stocks')
    .select('ticker, name, sector, market')
    .eq('is_watchlist', false)
    .in('market', markets)
    .limit(30);
  if (trimmed.length > 0) {
    q = q.or(`ticker.ilike.%${trimmed}%,name.ilike.%${trimmed}%`);
  }
  const { data } = await q;
  return data ?? [];
}

/**
 * Admin-only: discover unadded KR stocks ranked by recent market signals.
 *  - 'popular'      → highest trading_value
 *  - 'gainers'      → highest change_rate (price ↑)
 *  - 'foreign_buy'  → largest positive foreign_net_buy
 *  - 'ai_pick'      → highest final_score from latest ai_scores
 *
 * Returns up to `limit` rows enriched with quote + signal where available.
 */
export async function discoverUnaddedStocksAction(
  mode: DiscoveryMode,
  market: DiscoveryMarket = 'ALL',
  limit = 12,
): Promise<DiscoveryStock[]> {
  const sb = getAdminWriteClient();
  const markets = market === 'ALL' ? ['KOSPI', 'KOSDAQ'] : [market];

  // Latest market date (korea_market and ai_scores share daily refresh).
  const { data: latestKM } = await sb
    .from('korea_market')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const kmDate = latestKM?.date as string | undefined;

  const { data: latestAI } = await sb
    .from('ai_scores')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const aiDate = latestAI?.date as string | undefined;

  // 1) Determine candidate ticker order by mode.
  let orderedTickers: string[] = [];

  if (mode === 'ai_pick' && aiDate) {
    const { data } = await sb
      .from('ai_scores')
      .select('ticker, final_score')
      .eq('date', aiDate)
      .order('final_score', { ascending: false })
      .limit(200);
    orderedTickers = (data ?? []).map((r) => r.ticker as string);
  } else if (kmDate) {
    const orderCol =
      mode === 'gainers'
        ? 'change_rate'
        : mode === 'foreign_buy'
          ? 'foreign_net_buy'
          : 'trading_value';
    const res = await sb
      .from('korea_market')
      .select('ticker, ' + orderCol)
      .eq('date', kmDate)
      .order(orderCol, { ascending: false })
      .limit(300);
    const rows = (res.data ?? []) as unknown as { ticker: string }[];
    orderedTickers = rows.map((r) => r.ticker);
  }

  if (orderedTickers.length === 0) return [];

  // 2) Filter to unadded KR stocks in the requested market.
  const { data: stockMeta } = await sb
    .from('stocks')
    .select('ticker, name, sector, market, is_watchlist')
    .in('ticker', orderedTickers)
    .eq('is_watchlist', false)
    .in('market', markets);

  const metaByTicker = new Map<
    string,
    { name: string; sector: string | null; market: string }
  >();
  for (const s of stockMeta ?? []) {
    metaByTicker.set(s.ticker as string, {
      name: s.name as string,
      sector: s.sector as string | null,
      market: s.market as string,
    });
  }

  let filtered = orderedTickers.filter((t) => metaByTicker.has(t)).slice(0, limit);

  // Fallback: korea_market / ai_scores only cover the existing watchlist
  // (our pipeline doesn't ingest the whole KRX universe). When the curated
  // ranking returns nothing for the unadded set, fall back to a generic
  // alphabetical listing so the dialog still surfaces candidates.
  if (filtered.length === 0) {
    const { data: anyStocks } = await sb
      .from('stocks')
      .select('ticker, name, sector, market')
      .eq('is_watchlist', false)
      .in('market', markets)
      .order('name', { ascending: true })
      .limit(limit);
    for (const s of anyStocks ?? []) {
      metaByTicker.set(s.ticker as string, {
        name: s.name as string,
        sector: s.sector as string | null,
        market: s.market as string,
      });
    }
    filtered = (anyStocks ?? []).map((s) => s.ticker as string);
  }
  if (filtered.length === 0) return [];

  // 3) Enrich with quote + score in parallel.
  const [quoteRes, scoreRes] = await Promise.all([
    kmDate
      ? sb
          .from('korea_market')
          .select('ticker, close, change_rate, volume, trading_value, foreign_net_buy')
          .eq('date', kmDate)
          .in('ticker', filtered)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    aiDate
      ? sb
          .from('ai_scores')
          .select('ticker, final_score, signal')
          .eq('date', aiDate)
          .in('ticker', filtered)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const quoteByTicker = new Map<string, Record<string, number | null>>();
  for (const q of quoteRes.data ?? []) {
    quoteByTicker.set((q as { ticker: string }).ticker, q as Record<string, number | null>);
  }
  const scoreByTicker = new Map<string, { final_score: number; signal: string }>();
  for (const s of scoreRes.data ?? []) {
    const row = s as { ticker: string; final_score: number; signal: string };
    scoreByTicker.set(row.ticker, { final_score: row.final_score, signal: row.signal });
  }

  return filtered.map((ticker) => {
    const meta = metaByTicker.get(ticker)!;
    const quote = quoteByTicker.get(ticker) ?? {};
    const score = scoreByTicker.get(ticker);
    const close = (quote.close as number | null) ?? null;
    const change_rate = (quote.change_rate as number | null) ?? null;
    const volume = (quote.volume as number | null) ?? null;
    const trading_value = (quote.trading_value as number | null) ?? null;
    const foreign_net_buy = (quote.foreign_net_buy as number | null) ?? null;
    let highlight: string | null = null;
    if (mode === 'popular' && trading_value != null) {
      highlight = `거래대금 ${(trading_value / 1e8).toFixed(0)}억`;
    } else if (mode === 'gainers' && change_rate != null) {
      highlight = `${change_rate >= 0 ? '+' : ''}${change_rate.toFixed(2)}%`;
    } else if (mode === 'foreign_buy' && foreign_net_buy != null) {
      const sign = foreign_net_buy >= 0 ? '+' : '';
      highlight = `외인 ${sign}${(foreign_net_buy / 1e8).toFixed(0)}억`;
    } else if (mode === 'ai_pick' && score) {
      highlight = `AI ${(score.final_score * 100).toFixed(0)}점`;
    }
    return {
      ticker,
      name: meta.name,
      sector: meta.sector,
      market: meta.market,
      close,
      change_rate,
      volume,
      trading_value,
      foreign_net_buy,
      final_score: score?.final_score ?? null,
      signal: score?.signal ?? null,
      highlight,
    };
  });
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
