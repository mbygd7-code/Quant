import { NextRequest, NextResponse } from 'next/server';

import { KR_TICKER_RE } from '@/lib/ticker';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Price forecast for a KR ticker — honest random-walk-with-drift.
 *
 * WHY this and not the score regressor:
 *   The score-based ML model (signals/score_regressor.py) trains on
 *   ai_scores, which only has ~19 days of history per ticker after the
 *   2.5-month pipeline gap. With that little data GBM collapses to the
 *   mean and produces a flat forecast line. Price history, by contrast,
 *   is available for 250+ trading days straight from NAVER, so we can
 *   build a defensible forecast directly on prices.
 *
 * METHOD (random walk with damped drift):
 *   Let r_i = ln(close_i / close_{i-1}) be daily log returns over the
 *   last `lookback` trading days.
 *     drift μ      = mean(r)              (shrunk toward 0 — see below)
 *     volatility σ = stdev(r)
 *   For horizon h (trading days ahead):
 *     point(h) = lastClose · exp(μ_eff · h)
 *     band(h)  = lastClose · exp(μ_eff · h ± 1.96 · σ · √h)
 *
 *   μ is SHRUNK by DRIFT_SHRINK (0.5) because short-term drift is mostly
 *   noise — we don't want to over-extrapolate a recent run. The √h band
 *   growth is the standard random-walk uncertainty cone: honest about
 *   the fact that we cannot predict direction with confidence, only the
 *   plausible range. This is the right posture for an "AI 투자 판단 보조"
 *   tool that must never imply 확정/보장.
 *
 * Output prices are rounded to the nearest 100원 (KR tick convention).
 */
const ENDPOINT = 'https://api.stock.naver.com/chart/domestic/item';

const DRIFT_SHRINK = 0.5; // shrink mean daily return toward 0
const Z_95 = 1.959964; // two-sided 95%
const DEFAULT_LOOKBACK = 40; // trading days used to estimate μ, σ
const MIN_RETURNS = 10; // need at least this many returns to forecast

interface NaverDailyCandle {
  localDate: string; // "YYYYMMDD"
  closePrice: number;
}

interface HistPoint {
  date: string; // YYYY-MM-DD
  close: number;
}

interface ForecastPoint {
  date: string; // YYYY-MM-DD (next trading days, weekend-skipped)
  predicted: number;
  lower: number;
  upper: number;
  horizon: number; // 1..H
}

/** Fetch up to `bars` daily closes for a ticker from NAVER. Oldest-first. */
async function fetchDailyCloses(ticker: string, bars: number): Promise<HistPoint[]> {
  const fmt = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
      d.getDate(),
    ).padStart(2, '0')}0000`;
  const end = new Date();
  const start = new Date();
  // ~1.6 calendar days per trading day covers weekends + holidays.
  start.setDate(end.getDate() - Math.ceil(bars * 1.6));
  const url = `${ENDPOINT}/${ticker}/day?startDateTime=${fmt(start)}&endDateTime=${fmt(end)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Referer: 'https://stock.naver.com/',
      Accept: 'application/json',
    },
    next: { revalidate: 300 },
  });
  if (!res.ok) return [];
  const arr = (await res.json()) as NaverDailyCandle[];
  return arr
    .filter((c) => c.localDate && c.closePrice != null)
    .map((c) => ({
      date: `${c.localDate.slice(0, 4)}-${c.localDate.slice(4, 6)}-${c.localDate.slice(6, 8)}`,
      close: c.closePrice,
    }))
    .slice(-bars);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

/** Advance `from` by `n` trading days (skip Sat/Sun). Holidays are not
 *  modelled — close enough for a 5-day forecast label. */
function addTradingDays(from: Date, n: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added += 1;
  }
  return d;
}

const round100 = (v: number) => Math.round(v / 100) * 100;

export async function GET(req: NextRequest) {
  const ticker = (req.nextUrl.searchParams.get('ticker') ?? '').trim().toUpperCase();
  if (!KR_TICKER_RE.test(ticker)) {
    return NextResponse.json({ error: 'ticker= 6-char alphanumeric required' }, { status: 400 });
  }
  const horizon = Math.min(
    10,
    Math.max(1, Number(req.nextUrl.searchParams.get('horizon') ?? 5)),
  );
  const lookback = Math.min(
    120,
    Math.max(MIN_RETURNS, Number(req.nextUrl.searchParams.get('lookback') ?? DEFAULT_LOOKBACK)),
  );
  // History length: enough to draw a meaningful context window + lookback.
  const histBars = Math.max(60, lookback + 20);

  try {
    const history = await fetchDailyCloses(ticker, histBars);
    if (history.length < MIN_RETURNS + 1) {
      return NextResponse.json(
        { ticker, history, forecast: [], meta: { ok: false, reason: 'insufficient_history' } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // Daily log returns over the lookback window (most recent `lookback`).
    const closes = history.map((h) => h.close);
    const recent = closes.slice(-(lookback + 1));
    const rets: number[] = [];
    for (let i = 1; i < recent.length; i++) {
      if (recent[i - 1] > 0 && recent[i] > 0) {
        rets.push(Math.log(recent[i] / recent[i - 1]));
      }
    }
    if (rets.length < MIN_RETURNS) {
      return NextResponse.json(
        { ticker, history, forecast: [], meta: { ok: false, reason: 'insufficient_returns' } },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const muRaw = mean(rets);
    const sigma = stdev(rets);
    const muEff = muRaw * DRIFT_SHRINK;
    const lastClose = closes[closes.length - 1];
    const lastDate = new Date(history[history.length - 1].date);

    const forecast: ForecastPoint[] = [];
    for (let h = 1; h <= horizon; h++) {
      const center = lastClose * Math.exp(muEff * h);
      const halfWidth = Z_95 * sigma * Math.sqrt(h);
      const lower = lastClose * Math.exp(muEff * h - halfWidth);
      const upper = lastClose * Math.exp(muEff * h + halfWidth);
      const d = addTradingDays(lastDate, h);
      forecast.push({
        date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate(),
        ).padStart(2, '0')}`,
        predicted: round100(center),
        lower: round100(lower),
        upper: round100(upper),
        horizon: h,
      });
    }

    return NextResponse.json(
      {
        ticker,
        history,
        forecast,
        meta: {
          ok: true,
          last_close: lastClose,
          drift_daily: muEff, // already shrunk
          drift_raw: muRaw,
          vol_daily: sigma,
          lookback_used: rets.length,
          horizon,
          method: 'random_walk_drift_v1',
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'forecast failed' },
      { status: 500 },
    );
  }
}
