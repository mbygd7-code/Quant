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

type Period = '1d' | '1w' | '1w_intra' | '1m' | '3m' | '1y';

const PERIOD_MAP: Record<Period, {
  resolution: 'minute' | 'day' | 'week' | 'month';
  bars: number;
  calendarMult: number;
  /** When set, post-process minute bars into N-minute buckets so
   *  multi-day intraday views (1W) get professional 30-min granularity
   *  instead of 65×5min = 390 bars which would be unreadably dense. */
  aggregateMinutes?: number;
  /** Multi-day minute span — skip the single-day fallback loop and
   *  fetch one wide window covering ~9 calendar days. */
  intradayMultiDay?: boolean;
}> = {
  '1d':        { resolution: 'minute', bars: 78, calendarMult: 1 },     // ~6.5h × 5min bars
  '1w':        { resolution: 'day', bars: 5, calendarMult: 1.6 },        // legacy 1W = 5 daily candles
  // Pro 1W: 30-min intraday × 5 trading days = 13 × 5 = 65 bars.
  // Matches TradingView / Bloomberg convention for "5D / 1W" view —
  // enough intraday granularity to see opening drives, lunch lulls,
  // and closing auctions without becoming a 400-bar wall of noise.
  '1w_intra':  { resolution: 'minute', bars: 65, calendarMult: 1, aggregateMinutes: 30, intradayMultiDay: true },
  '1m':        { resolution: 'day', bars: 22, calendarMult: 1.6 },
  '3m':        { resolution: 'day', bars: 65, calendarMult: 1.6 },
  '1y':        { resolution: 'day', bars: 252, calendarMult: 1.6 },
};

/** Aggregate raw minute candles into N-minute buckets keyed by
 *  YYYYMMDDHHMM (bucket start). Assumes input is in chronological
 *  order — NAVER returns oldest-first which is what we get. */
function aggregateMinuteCandles(
  bars: NaverMinuteCandle[],
  minutes: number,
): NaverMinuteCandle[] {
  const buckets = new Map<string, NaverMinuteCandle>();
  const order: string[] = [];
  for (const c of bars) {
    const ld = c.localDateTime;
    if (!ld || ld.length < 12) continue;
    const m = parseInt(ld.slice(10, 12), 10);
    if (!Number.isFinite(m)) continue;
    const bucketMin = Math.floor(m / minutes) * minutes;
    const key = `${ld.slice(0, 10)}${String(bucketMin).padStart(2, '0')}00`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        localDateTime: key,
        // Open of the bucket = open of the first (chronologically) bar.
        openPrice: c.openPrice,
        highPrice: c.highPrice,
        lowPrice: c.lowPrice,
        // Close gets overwritten by every subsequent bar in the bucket,
        // ending at the bucket's last bar — correct OHLC semantics.
        currentPrice: c.currentPrice,
        accumulatedTradingVolume: c.accumulatedTradingVolume,
      });
      order.push(key);
    } else {
      existing.highPrice = Math.max(existing.highPrice, c.highPrice);
      existing.lowPrice = Math.min(existing.lowPrice, c.lowPrice);
      existing.currentPrice = c.currentPrice;
      existing.accumulatedTradingVolume += c.accumulatedTradingVolume;
    }
  }
  return order.map((k) => buckets.get(k)!);
}

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

    if (cfg.resolution === 'minute' && cfg.intradayMultiDay) {
      // Multi-day intraday (1W view) — fetch ONE wide window covering
      // ~9 calendar days (>5 trading days even with a long weekend +
      // holiday). Then aggregate 5-min raw bars into 30-min buckets.
      const end = new Date();
      const start = new Date();
      start.setDate(end.getDate() - 9);
      start.setHours(9, 0, 0, 0);
      const raw = (await fetchWindow(start, end)) ?? [];
      const minuteBars = raw.filter((c): c is NaverMinuteCandle => 'localDateTime' in c);
      arr = cfg.aggregateMinutes
        ? aggregateMinuteCandles(minuteBars, cfg.aggregateMinutes)
        : minuteBars;
    } else if (cfg.resolution === 'minute') {
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
