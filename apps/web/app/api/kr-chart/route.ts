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

  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;

  /** Run one fetch attempt and return the raw NAVER array. Empty array
   *  ([]) is a valid response — used by the 1D fallback loop to detect
   *  non-trading days and try a previous calendar day. */
  async function fetchWindow(start: Date, end: Date): Promise<NaverCandle[] | null> {
    const url =
      cfg.resolution === 'minute'
        ? `${ENDPOINT}/${ticker}/minute?startDateTime=${fmt(start)}&endDateTime=${fmt(end)}`
        : `${ENDPOINT}/${ticker}/${cfg.resolution}?startDateTime=${fmt(start)}&endDateTime=${fmt(end)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://stock.naver.com/',
        Accept: 'application/json',
      },
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json()) as NaverCandle[];
  }

  try {
    let arr: NaverCandle[] | null = null;
    let intradayDateUsed: string | null = null;

    if (cfg.resolution === 'minute') {
      // 1D intraday — try today first. If empty (weekend / pre-market /
      // public holiday), walk back up to 5 calendar days to find the
      // most recent trading day. This keeps the chart populated even
      // on weekends instead of showing '차트 데이터 없음'.
      for (let daysBack = 0; daysBack <= 5; daysBack++) {
        const dayStart = new Date();
        dayStart.setDate(dayStart.getDate() - daysBack);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        // For today we use 'now'; for past days we use 15:30 (KRX close).
        if (daysBack === 0) {
          dayEnd.setHours(new Date().getHours(), new Date().getMinutes(), 0, 0);
        } else {
          dayEnd.setHours(15, 30, 0, 0);
        }
        const candidate = await fetchWindow(dayStart, dayEnd);
        if (candidate && candidate.length > 0) {
          arr = candidate;
          intradayDateUsed = dayStart.toISOString().slice(0, 10);
          break;
        }
      }
      if (!arr) arr = [];
    } else {
      // Daily / weekly / monthly — single window covers enough calendar
      // days to absorb non-trading gaps.
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - Math.ceil(bars * cfg.calendarMult));
      arr = (await fetchWindow(start, end)) ?? [];
    }

    void intradayDateUsed; // surfaced via X-Intraday-Date header below if needed
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
      {
        ticker,
        period,
        candles,
        // Expose which intraday day was actually used so the UI can
        // display '5/15 (이전 거래일)' instead of pretending the data
        // is today's when it falls back.
        intraday_date: intradayDateUsed,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 500 },
    );
  }
}
