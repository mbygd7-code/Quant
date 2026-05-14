import { NextRequest, NextResponse } from 'next/server';

import { KR_TICKER_RE } from '@/lib/ticker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Bulk KR equity quote proxy backed by NAVER's real-time polling API.
 * The same endpoint that powers stock.naver.com — no auth, returns
 * current price + change vs previous close. During market hours
 * (KST 09:00–15:30) prices update; outside hours it returns the most
 * recent close.
 */
const ENDPOINT = 'https://polling.finance.naver.com/api/realtime/domestic/stock';

const NUM = (v: unknown): number | null => {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

interface NaverQuote {
  itemCode?: string;
  stockName?: string;
  closePrice?: string;
  compareToPreviousClosePrice?: string;
  compareToPreviousPrice?: { code?: string; text?: string; name?: string };
  fluctuationsRatio?: string;
  openPrice?: string;
  highPrice?: string;
  lowPrice?: string;
  accumulatedTradingVolume?: string;
  marketStatus?: string;
  localTradedAt?: string;
}

interface QuoteResult {
  ticker: string;
  ok: boolean;
  name?: string;
  price?: number | null;
  change?: number | null;
  changeRate?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  volume?: number | null;
  marketStatus?: string | null;
  tradedAt?: string | null;
  error?: string;
}

async function fetchOne(ticker: string): Promise<QuoteResult> {
  try {
    const res = await fetch(`${ENDPOINT}/${encodeURIComponent(ticker)}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://finance.naver.com/',
      },
      cache: 'no-store',
    });
    if (!res.ok) return { ticker, ok: false, error: `naver ${res.status}` };
    const j = (await res.json()) as { datas?: NaverQuote[] };
    const q = j.datas?.[0];
    if (!q) return { ticker, ok: false, error: 'no data' };
    // Sign of change: NAVER's compareToPreviousClosePrice already encodes sign,
    // but their "FALLING/RISING" code is in compareToPreviousPrice.code:
    //   1=상한, 2=상승, 3=보합, 4=하한, 5=하락
    let change = NUM(q.compareToPreviousClosePrice);
    const dir = q.compareToPreviousPrice?.code;
    if (change != null && (dir === '4' || dir === '5')) {
      change = -Math.abs(change);
    }
    let changeRate = NUM(q.fluctuationsRatio);
    if (changeRate != null && (dir === '4' || dir === '5')) {
      changeRate = -Math.abs(changeRate);
    }
    return {
      ticker,
      ok: true,
      name: q.stockName,
      price: NUM(q.closePrice),
      change,
      changeRate,
      open: NUM(q.openPrice),
      high: NUM(q.highPrice),
      low: NUM(q.lowPrice),
      volume: NUM(q.accumulatedTradingVolume),
      marketStatus: q.marketStatus ?? null,
      tradedAt: q.localTradedAt ?? null,
    };
  } catch (e) {
    return { ticker, ok: false, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get('tickers') ?? '';
  const tickers = tickersParam
    .split(',')
    .map((s) => s.trim())
    .map((s) => s.toUpperCase())
    .filter((s) => KR_TICKER_RE.test(s))
    .slice(0, 30);
  if (tickers.length === 0) {
    return NextResponse.json({ error: 'tickers= required (6-digit, comma-separated)' }, { status: 400 });
  }
  const results = await Promise.all(tickers.map(fetchOne));
  return NextResponse.json(
    { fetchedAt: new Date().toISOString(), results },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
