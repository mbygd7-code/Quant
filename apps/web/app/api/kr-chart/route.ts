import { NextRequest, NextResponse } from 'next/server';

import { KR_TICKER_RE } from '@/lib/ticker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * NAVER daily-candle proxy. Returns the last `days` trading days of
 * OHLCV for a 6-digit KR ticker. No auth required — same endpoint
 * stock.naver.com itself uses for the daily chart.
 */
const ENDPOINT = 'https://api.stock.naver.com/chart/domestic/item';

/** NAVER returns two slightly different shapes:
 *    - daily / weekly / monthly: { localDate: "YYYYMMDD", closePrice, … }
 *    - minute (1D intraday):     { localDateTime: "YYYYMMDDHHMMSS", currentPrice, … }
 *  Both share open/high/low/volume field names but the close + date
 *  field names differ. We normalize on the proxy side. */
interface NaverDailyCandle {
  localDate: string;        // "YYYYMMDD"
  closePrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  accumulatedTradingVolume: number;
}

interface NaverMinuteCandle {
  localDateTime: string;    // "YYYYMMDDHHMMSS"
  currentPrice: number;
  openPrice: number;
  highPrice: number;
  lowPrice: number;
  accumulatedTradingVolume: number;
}

type NaverCandle = NaverDailyCandle | NaverMinuteCandle;

type Period = '1d' | '1w' | '1m' | '3m' | '1y';

const PERIOD_MAP: Record<Period, { resolution: 'minute' | 'day' | 'week' | 'month'; bars: number; calendarMult: number }> = {
  '1d': { resolution: 'minute', bars: 78, calendarMult: 1 },     // ~6.5h × 5min bars
  '1w': { resolution: 'day', bars: 5, calendarMult: 1.6 },
  '1m': { resolution: 'day', bars: 22, calendarMult: 1.6 },
  '3m': { resolution: 'day', bars: 65, calendarMult: 1.6 },
  '1y': { resolution: 'day', bars: 252, calendarMult: 1.6 },
};

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim().toUpperCase();
  if (!KR_TICKER_RE.test(ticker)) {
    return NextResponse.json({ error: 'ticker= 6-char alphanumeric required' }, { status: 400 });
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
      // Daily candles don't change intra-day — cache 5 min upstream so a
      // detail-page reload doesn't re-fetch NAVER on every refresh. The
      // route handler is still `force-dynamic` (per-user response shape),
      // but the upstream fetch is shared across users via Next's cache.
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `naver ${res.status}` }, { status: 502 });
    }
    const arr = (await res.json()) as NaverCandle[];
    const candles = arr.slice(-bars).map((c) => {
      // Minute response uses localDateTime + currentPrice; daily uses
      // localDate + closePrice. Read either and normalize.
      const isMinute = 'localDateTime' in c;
      const ld = isMinute
        ? (c as NaverMinuteCandle).localDateTime
        : (c as NaverDailyCandle).localDate;
      const dateStr = ld ?? '';
      const date =
        dateStr.length >= 8
          ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}${
              dateStr.length >= 12 ? ` ${dateStr.slice(8, 10)}:${dateStr.slice(10, 12)}` : ''
            }`
          : dateStr;
      const close = isMinute
        ? (c as NaverMinuteCandle).currentPrice
        : (c as NaverDailyCandle).closePrice;
      return {
        date,
        open: c.openPrice,
        high: c.highPrice,
        low: c.lowPrice,
        close,
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
