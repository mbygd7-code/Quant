/**
 * Resolve raw ticker codes to (name, market, sector) metadata.
 *
 * Used by the LNB Sidebar to render favorites that aren't part of the
 * AI-tracked watchlist universe — e.g. a user-added ticker pulled from
 * an external search. We hit the `stocks` master table first; anything
 * still unresolved is returned as `{name: ticker, market: '', sector: null}`
 * so the rail still shows *something* clickable.
 */
import { NextResponse } from 'next/server';

import { getQueryClient } from '@/lib/supabase/query-client';
import { KR_TICKER_RE } from '@/lib/ticker';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get('tickers') ?? '';
  const tickers = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 100); // hard cap — the rail can't realistically show more

  if (tickers.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const sb = await getQueryClient();
  const { data } = await sb
    .from('stocks')
    .select('ticker, name, market, sector')
    .in('ticker', tickers);

  const byTicker = new Map<string, { name: string; market: string; sector: string | null }>();
  for (const row of (data ?? []) as Array<{ ticker: string; name: string; market: string; sector: string | null }>) {
    byTicker.set(row.ticker, {
      name: row.name,
      market: row.market,
      sector: row.sector,
    });
  }

  // Tickers not in master OR with a placeholder name (== the ticker code
  // itself) get resolved via NAVER mobile stock API so the LNB can show the
  // real Korean name instead of a 6-digit code.
  const unresolved = tickers.filter((t) => {
    if (!KR_TICKER_RE.test(t.toUpperCase())) return false;
    const hit = byTicker.get(t);
    if (!hit) return true;
    return hit.name === t || hit.name.trim() === '';
  });
  await Promise.all(
    unresolved.map(async (t) => {
      try {
        const res = await fetch(
          `https://m.stock.naver.com/api/stock/${t}/integration`,
          {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
              Accept: 'application/json',
            },
            cache: 'no-store',
          },
        );
        if (!res.ok) return;
        const j = (await res.json()) as {
          stockName?: string;
          stockExchangeType?: { code?: string; name?: string };
          industryCodeType?: { name?: string };
        };
        if (j.stockName) {
          byTicker.set(t, {
            name: j.stockName,
            market:
              j.stockExchangeType?.code === 'KOSPI'
                ? 'KOSPI'
                : j.stockExchangeType?.code === 'KOSDAQ'
                  ? 'KOSDAQ'
                  : j.stockExchangeType?.name ?? '',
            sector: j.industryCodeType?.name ?? null,
          });
        }
      } catch {
        /* network blip — leave unresolved */
      }
    }),
  );

  const items = tickers.map((t) => {
    const hit = byTicker.get(t);
    return {
      ticker: t,
      name: hit?.name ?? t,
      market: hit?.market ?? '',
      sector: hit?.sector ?? null,
      resolved: Boolean(hit),
    };
  });

  return NextResponse.json({ items });
}
