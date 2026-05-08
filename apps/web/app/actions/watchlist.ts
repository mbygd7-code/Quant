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

// ─── Full KRX search (NAVER autocomplete) ────────────────────────────
// Finnhub gates KRX symbol catalog behind a paid plan and Yahoo's public
// search rejects Korean characters with HTTP 400. NAVER's autocomplete
// (the same endpoint that powers stock.naver.com's search bar) handles
// Korean queries natively, returns 6-digit codes + market labels, and
// requires no auth. It's an informal API but extremely stable since
// NAVER's own mobile app depends on it.
interface NaverAcItem {
  code: string;       // 6-digit ticker for KR equities
  name: string;       // Korean name (e.g. "삼성전자")
  typeCode: string;   // "KOSPI" | "KOSDAQ" | "NYSE" | "HONG_KONG" | ...
  category: string;   // "stock" | "etf" | ...
  nationCode?: string;
}

async function naverKrSearch(query: string, limit: number): Promise<{
  ticker: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
}[]> {
  const url = `https://ac.stock.naver.com/ac?q=${encodeURIComponent(query)}&target=stock`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`NAVER ac ${res.status}`);
  const j = (await res.json()) as { items?: NaverAcItem[] };
  const items = j.items ?? [];
  return items
    .filter((it) => (it.typeCode === 'KOSPI' || it.typeCode === 'KOSDAQ') && /^\d{6}$/.test(it.code))
    .slice(0, limit)
    .map((it) => ({
      ticker: it.code,
      name: it.name,
      market: it.typeCode as 'KOSPI' | 'KOSDAQ',
    }));
}

export interface AllKrSearchResult {
  ticker: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  sector: string | null;
  inMaster: boolean;     // exists in stocks table
  inWatchlist: boolean;  // stocks.is_watchlist = true
}

/**
 * Admin-only: search the FULL KRX universe (KOSPI + KOSDAQ, ~2,500 names)
 * via Yahoo Finance search, cross-referenced with our local stocks
 * master so the UI knows which are already added.
 *
 * Returns up to `limit` matches; supports Korean (e.g. "삼성") and ticker
 * prefix (e.g. "005930"). Results are ordered by Yahoo relevance.
 */
export async function searchAllKrStocksAction(
  query: string,
  market: DiscoveryMarket = 'ALL',
  limit = 30,
): Promise<AllKrSearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  let hits: { ticker: string; name: string; market: 'KOSPI' | 'KOSDAQ' }[];
  try {
    hits = await naverKrSearch(trimmed, limit);
  } catch (e) {
    console.error('[searchAllKrStocksAction] naver ac failed:', e);
    return [];
  }

  const filtered = market === 'ALL' ? hits : hits.filter((r) => r.market === market);
  if (filtered.length === 0) return [];

  // Cross-reference with stocks master
  const sb = getAdminWriteClient();
  const tickers = filtered.map((r) => r.ticker);
  const { data: existing } = await sb
    .from('stocks')
    .select('ticker, is_watchlist, sector')
    .in('ticker', tickers);
  const existingMap = new Map<string, { is_watchlist: boolean; sector: string | null }>();
  for (const e of existing ?? []) {
    existingMap.set(e.ticker as string, {
      is_watchlist: Boolean(e.is_watchlist),
      sector: (e.sector as string | null) ?? null,
    });
  }

  return filtered.map((r) => {
    const e = existingMap.get(r.ticker);
    return {
      ticker: r.ticker,
      name: r.name,
      market: r.market,
      sector: e?.sector ?? null,
      inMaster: e !== undefined,
      inWatchlist: e?.is_watchlist ?? false,
    };
  });
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
  // ranking returns nothing for the unadded set, fall back to live NAVER
  // snapshots so each mode still shows differentiated rankings instead
  // of the same alphabetical list.
  let liveSnapshots: Map<string, NaverLiveSnap> | null = null;
  if (filtered.length === 0) {
    const { data: anyStocks } = await sb
      .from('stocks')
      .select('ticker, name, sector, market')
      .eq('is_watchlist', false)
      .in('market', markets)
      .order('ticker', { ascending: true })
      .limit(80); // cap NAVER fan-out
    for (const s of anyStocks ?? []) {
      metaByTicker.set(s.ticker as string, {
        name: s.name as string,
        sector: s.sector as string | null,
        market: s.market as string,
      });
    }
    const universe = (anyStocks ?? []).map((s) => s.ticker as string);
    if (universe.length > 0) {
      liveSnapshots = await fetchNaverSnapshots(universe);
      // Sort by mode using live data
      const cmp = (a: string, b: string): number => {
        const sa = liveSnapshots!.get(a);
        const sb_ = liveSnapshots!.get(b);
        if (mode === 'popular') {
          return (sb_?.tradingValue ?? 0) - (sa?.tradingValue ?? 0);
        }
        if (mode === 'gainers') {
          return (sb_?.changeRate ?? -999) - (sa?.changeRate ?? -999);
        }
        if (mode === 'foreign_buy') {
          return (sb_?.foreignRetentionRate ?? 0) - (sa?.foreignRetentionRate ?? 0);
        }
        // ai_pick — no AI scores, use volume as a proxy so it's different
        // from popular (which uses value). Volume favors lower-priced
        // active names; value favors blue-chips.
        return (sb_?.volume ?? 0) - (sa?.volume ?? 0);
      };
      filtered = [...universe].sort(cmp).slice(0, limit);
    }
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
    const live = liveSnapshots?.get(ticker);
    const close = (quote.close as number | null) ?? live?.price ?? null;
    const change_rate = (quote.change_rate as number | null) ?? live?.changeRate ?? null;
    const volume = (quote.volume as number | null) ?? live?.volume ?? null;
    const trading_value = (quote.trading_value as number | null) ?? live?.tradingValue ?? null;
    const foreign_net_buy = (quote.foreign_net_buy as number | null) ?? null;
    let highlight: string | null = null;
    if (mode === 'popular' && trading_value != null) {
      highlight = `거래대금 ${(trading_value / 1e8).toFixed(0)}억`;
    } else if (mode === 'gainers' && change_rate != null) {
      highlight = `${change_rate >= 0 ? '+' : ''}${change_rate.toFixed(2)}%`;
    } else if (mode === 'foreign_buy' && foreign_net_buy != null) {
      const sign = foreign_net_buy >= 0 ? '+' : '';
      highlight = `외인 ${sign}${(foreign_net_buy / 1e8).toFixed(0)}억`;
    } else if (mode === 'foreign_buy' && live?.foreignRetentionRate != null) {
      // Fallback proxy when foreign_net_buy isn't ingested yet
      highlight = `외인보유 ${live.foreignRetentionRate.toFixed(1)}%`;
    } else if (mode === 'ai_pick' && score) {
      highlight = `AI ${(score.final_score * 100).toFixed(0)}점`;
    } else if (mode === 'ai_pick' && live?.volume != null) {
      // Fallback proxy: volume = activity. Communicates "still differentiated".
      highlight = `거래량 ${(live.volume / 1e4).toFixed(0)}만주`;
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

// ─── NAVER live snapshot fan-out (used by discovery fallback) ────────
interface NaverLiveSnap {
  price: number | null;
  change: number | null;
  changeRate: number | null;
  volume: number | null;
  tradingValue: number | null;       // KRW
  foreignRetentionRate: number | null;
}

async function fetchNaverSnapshots(tickers: string[]): Promise<Map<string, NaverLiveSnap>> {
  const NUM = (v: unknown): number | null => {
    if (v == null) return null;
    const s = String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, '').trim();
    if (!s || s === '-' || s === '.') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const out = new Map<string, NaverLiveSnap>();
  // Bound concurrency at 16 — NAVER tolerates parallel calls but be polite.
  const CHUNK = 16;
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (ticker) => {
        try {
          const res = await fetch(
            `https://polling.finance.naver.com/api/realtime/domestic/stock/${ticker}`,
            {
              headers: {
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
                Referer: 'https://finance.naver.com/',
                Accept: 'application/json',
              },
              cache: 'no-store',
            },
          );
          if (!res.ok) return null;
          const j = (await res.json()) as { datas?: Array<Record<string, unknown>> };
          const q = j.datas?.[0];
          if (!q) return null;
          let change = NUM(q.compareToPreviousClosePrice);
          let changeRate = NUM(q.fluctuationsRatio);
          const dir =
            (q.compareToPreviousPrice as { code?: string } | undefined)?.code;
          if (dir === '4' || dir === '5') {
            if (change != null) change = -Math.abs(change);
            if (changeRate != null) changeRate = -Math.abs(changeRate);
          }
          const price = NUM(q.closePrice);
          const volume = NUM(q.accumulatedTradingVolume);
          // accumulatedTradingValue is "6,809,050백만" → millions of KRW
          const tvRaw = String(q.accumulatedTradingValue ?? '');
          const tvMillion = NUM(tvRaw);
          const tradingValue = tvMillion != null ? tvMillion * 1_000_000 : null;
          return [
            ticker,
            {
              price,
              change,
              changeRate,
              volume,
              tradingValue,
              foreignRetentionRate: NUM(q.foreignRetentionRate),
            } satisfies NaverLiveSnap,
          ] as const;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) if (r) out.set(r[0], r[1]);
  }
  return out;
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
 * Admin-only: add a stock to the master watchlist, inserting a new
 * stocks row if the ticker isn't yet known. Used by the full-KRX
 * search result rows (Finnhub catalog hits that aren't in our DB).
 */
export async function adminAddOrCreateStockAction(stock: {
  ticker: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  sector?: string | null;
}): Promise<{ ok?: true; error?: string }> {
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
    .from('stocks')
    .select('ticker, name, is_watchlist')
    .eq('ticker', stock.ticker)
    .maybeSingle();

  if (before) {
    if (before.is_watchlist) return { ok: true }; // idempotent
    const { error } = await sb
      .from('stocks')
      .update({ is_watchlist: true })
      .eq('ticker', stock.ticker);
    if (error) return { error: error.message };
  } else {
    const { error } = await sb.from('stocks').insert({
      ticker: stock.ticker,
      name: stock.name,
      market: stock.market,
      sector: stock.sector ?? null,
      is_watchlist: true,
    });
    if (error) return { error: error.message };
  }
  await recordAudit({
    action: 'watchlist.add',
    resource_type: 'stocks',
    resource_id: stock.ticker,
    changes: {
      before: before ?? null,
      after: { is_watchlist: true, name: stock.name, market: stock.market },
    },
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
