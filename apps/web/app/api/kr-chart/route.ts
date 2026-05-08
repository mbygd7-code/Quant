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

type Period = '1d' | '1w' | '1m' | '3m' | '1y';

const PERIOD_MAP: Record<Period, { resolution: 'minute' | 'day' | 'week' | 'month'; bars: number; calendarMult: number }> = {
  '1d': { resolution: 'minute', bars: 78, calendarMult: 1 },     // ~6.5h × 5min bars
  '1w': { resolution: 'day', bars: 5, calendarMult: 1.6 },
  '1m': { resolution: 'day', bars: 22, calendarMult: 1.6 },
  '3m': { resolution: 'day', bars: 65, calendarMult: 1.6 },
  '1y': { resolution: 'day', bars: 252, calendarMult: 1.6 },
};

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim();
  if (!/^\d{6}$/.test(ticker)) {
    return NextResponse.json({ error: 'ticker= 6-digit required' }, { status: 400 });
  }
  const period = (req.nextUrl.searchParams.get('period') ?? '3m') as Period;
  const cfg = PERIOD_MAP[period] ?? PERIOD_MAP['3m'];
  // Backwards-compat: also honor explicit `days=N` for the legacy sparkline
  // hook that asked for 30-day daily.
  const explicitDays = Number(req.nextUrl.searchParams.get('days') ?? 0);
  const bars = explicitDays > 0 ? Math.min(365, explicitDays) : cfg.bars;

  const end = new Date();
  const start = new Date();
  // Calendar window padded for non-trading days; 1d intraday uses today only.
  if (cfg.resolution === 'minute') {
    start.setHours(0, 0, 0, 0);
  } else {
    start.setDate(end.getDate() - Math.ceil(bars * cfg.calendarMult));
  }
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;

  const url =
    cfg.resolution === 'minute'
      ? `${ENDPOINT}/${ticker}/minute?startDateTime=${fmt(start)}&endDateTime=${fmt(end)}`
      : `${ENDPOINT}/${ticker}/${cfg.resolution}?startDateTime=${fmt(start)}&endDateTime=${fmt(end)}`;

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
    const candles = arr.slice(-bars).map((c) => {
      const ld = c.localDate ?? '';
      const date =
        ld.length >= 8
          ? `${ld.slice(0, 4)}-${ld.slice(4, 6)}-${ld.slice(6, 8)}${
              ld.length >= 12 ? ` ${ld.slice(8, 10)}:${ld.slice(10, 12)}` : ''
            }`
          : ld;
      return {
        date,
        open: c.openPrice,
        high: c.highPrice,
        low: c.lowPrice,
        close: c.closePrice,
        volume: c.accumulatedTradingVolume,
      };
    });
    return NextResponse.json(
      { ticker, period, candles },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 500 },
    );
  }
}
