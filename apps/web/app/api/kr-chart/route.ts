import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * NAVER daily-candle proxy. Returns the last `days` trading days of
 * OHLCV for a 6-digit KR ticker. No auth required — same endpoint
 * stock.naver.com itself uses for the daily chart.
 */
const ENDPOINT = 'https://api.stock.naver.com/chart/domestic/item';

interface NaverCandle {
  localDate: string;        // "YYYYMMDD"
  closePrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  accumulatedTradingVolume: number;
}

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim();
  if (!/^\d{6}$/.test(ticker)) {
    return NextResponse.json({ error: 'ticker= 6-digit required' }, { status: 400 });
  }
  const days = Math.max(7, Math.min(365, Number(req.nextUrl.searchParams.get('days') ?? 90)));

  const end = new Date();
  const start = new Date();
  // Pull a wider window than `days` (calendar vs trading-day skew + holidays)
  // and slice down at the end.
  start.setDate(end.getDate() - Math.ceil(days * 1.6));
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}000000`;

  const url = `${ENDPOINT}/${ticker}/day?startDateTime=${fmt(start)}&endDateTime=${fmt(end)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://stock.naver.com/',
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `naver ${res.status}` }, { status: 502 });
    }
    const arr = (await res.json()) as NaverCandle[];
    const candles = arr
      .slice(-days)
      .map((c) => ({
        date: `${c.localDate.slice(0, 4)}-${c.localDate.slice(4, 6)}-${c.localDate.slice(6, 8)}`,
        open: c.openPrice,
        high: c.highPrice,
        low: c.lowPrice,
        close: c.closePrice,
        volume: c.accumulatedTradingVolume,
      }));
    return NextResponse.json(
      { ticker, candles },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 500 },
    );
  }
}
