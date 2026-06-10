import { NextRequest, NextResponse } from 'next/server';

import { KR_TICKER_RE } from '@/lib/ticker';
import { createAdminClient } from '@/lib/supabase/admin';

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

// Overnight US→KR open gap (kr_overnight_betas). Only apply when the
// lead-lag link is strong enough to be signal, and cap the nudge so a
// single wild US night can't dominate the forecast.
const OVERNIGHT_MIN_R2 = 0.08; // gate: below this the link is noise
const OVERNIGHT_GAP_CAP_VOL = 2.5; // cap |gap| at this × daily σ

// Expert-tilt calibration (mirrors signals/price_forecast.py — keep in
// sync). Until MIN_CALIB_N evaluated ledger rows exist, k stays at the
// small prior; afterwards it's learned from corr(expert_score, realized
// return) so expert influence GROWS with demonstrated accuracy and
// decays to 0 when their calls don't map to prices.
const K_PRIOR = 0.15;
const MIN_CALIB_N = 20;
const K_MAX = 0.5;

interface OvernightSignal {
  us_symbol: string;
  beta: number;
  correlation: number;
  r_squared: number;
  us_return: number; // most recent overnight US move (log-equivalent fraction)
  us_date: string;
  gap: number; // applied level shift in log space (post-gate, post-cap)
}

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

/**
 * Look up the ticker's strongest overnight US proxy and the most recent
 * US session move that drives its next open. Returns null on any miss
 * (no beta row, table absent, weak link, no fresh US data) so the
 * forecast degrades gracefully to pure random-walk.
 *
 * `sigma` (daily log-return stdev) is used to cap the gap.
 */
async function fetchOvernightSignal(
  ticker: string,
  lastKrDate: string,
  sigma: number,
): Promise<OvernightSignal | null> {
  let sb: ReturnType<typeof createAdminClient>;
  try {
    sb = createAdminClient();
  } catch {
    return null; // service role not configured — skip silently
  }

  // Best proxy for this ticker (highest R² row).
  const { data: betaRows, error: betaErr } = await sb
    .from('kr_overnight_betas')
    .select('us_symbol, beta, correlation, r_squared')
    .eq('kr_ticker', ticker)
    .order('r_squared', { ascending: false })
    .limit(1);
  if (betaErr || !betaRows || betaRows.length === 0) return null;
  const b = betaRows[0] as {
    us_symbol: string;
    beta: number;
    correlation: number;
    r_squared: number;
  };
  if (b.r_squared == null || b.r_squared < OVERNIGHT_MIN_R2) return null;

  // Most recent US session on/before the last KR close — that's the
  // overnight move that will gap the next KR open (matches the lag-1
  // alignment used to fit the beta).
  const { data: usRows, error: usErr } = await sb
    .from('global_market')
    .select('date, change_rate')
    .eq('symbol', b.us_symbol)
    .lte('date', lastKrDate)
    .not('change_rate', 'is', null)
    .order('date', { ascending: false })
    .limit(1);
  if (usErr || !usRows || usRows.length === 0) return null;
  const us = usRows[0] as { date: string; change_rate: number };
  if (us.change_rate == null) return null;

  // Raw gap in log space, then capped at ±cap·σ.
  const rawGap = b.beta * us.change_rate;
  const cap = OVERNIGHT_GAP_CAP_VOL * sigma;
  const gap = Math.max(-cap, Math.min(cap, rawGap));

  return {
    us_symbol: b.us_symbol,
    beta: b.beta,
    correlation: b.correlation,
    r_squared: b.r_squared,
    us_return: us.change_rate,
    us_date: us.date,
    gap,
  };
}

interface ExpertSignal {
  score: number; // soros weighted_score (-2..+2)
  grade: string | null;
  tilt: number; // applied per-day log drift
}

interface TrackRow {
  forecast_date: string;
  target_date: string;
  base_price: number;
  predicted: number;
  lower_band: number;
  upper_band: number;
  expert_grade: string | null;
  actual: number | null;
  actual_date: string | null;
  direction_hit: boolean | null;
  within_band: boolean | null;
  abs_pct_err: number | null;
}

interface Calibration {
  k: number;
  band_mult: number;
  n_evaluated: number;
  direction_hit_rate: number | null;
  coverage: number | null;
  median_abs_err: number | null;
}

/** Pooled calibration + this ticker's recent track from the forecast
 *  ledger. Mirrors signals/price_forecast.py::load_calibration. */
async function fetchLedger(
  sb: ReturnType<typeof createAdminClient>,
  ticker: string,
): Promise<{ calib: Calibration; track: TrackRow[] }> {
  const fallback: Calibration = {
    k: K_PRIOR,
    band_mult: 1.0,
    n_evaluated: 0,
    direction_hit_rate: null,
    coverage: null,
    median_abs_err: null,
  };
  // Pooled evaluated rows (cross-ticker — per-ticker n grows too slowly).
  const { data: evalRows } = await sb
    .from('price_forecasts')
    .select('expert_score, base_price, actual, direction_hit, within_band, abs_pct_err, horizon_days')
    .not('actual', 'is', null)
    .limit(2000);
  const rows = (evalRows ?? []) as Array<{
    expert_score: number | null;
    base_price: number;
    actual: number;
    direction_hit: boolean | null;
    within_band: boolean | null;
    abs_pct_err: number | null;
    horizon_days: number | null;
  }>;
  let calib = fallback;
  if (rows.length > 0) {
    const hits = rows.filter((r) => r.direction_hit != null);
    const inband = rows.filter((r) => r.within_band != null);
    const errs = rows
      .map((r) => r.abs_pct_err)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const hitRate = hits.length ? hits.filter((r) => r.direction_hit).length / hits.length : null;
    const coverage = inband.length
      ? inband.filter((r) => r.within_band).length / inband.length
      : null;
    let k = K_PRIOR;
    let bandMult = 1.0;
    if (rows.length >= MIN_CALIB_N) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const r of rows) {
        if (r.expert_score == null || !r.actual || !r.base_price) continue;
        xs.push(r.expert_score);
        ys.push(Math.log(r.actual / r.base_price) / (r.horizon_days ?? 5));
      }
      if (xs.length >= 3) {
        const mx = mean(xs);
        const my = mean(ys);
        const sx = stdev(xs);
        const sy = stdev(ys);
        if (sx > 0 && sy > 0) {
          const cov =
            xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) / (xs.length - 1);
          k = Math.max(0, Math.min(K_MAX, cov / (sx * sy)));
        }
      }
      if (coverage != null) {
        if (coverage < 0.8) bandMult = 1.25;
        else if (coverage < 0.9) bandMult = 1.1;
        else if (coverage > 0.99) bandMult = 0.9;
      }
    }
    calib = {
      k,
      band_mult: bandMult,
      n_evaluated: rows.length,
      direction_hit_rate: hitRate,
      coverage,
      median_abs_err: errs.length ? errs[Math.floor(errs.length / 2)] : null,
    };
  }
  // This ticker's recent forecasts (evaluated + pending) for the overlay.
  const { data: trackRows } = await sb
    .from('price_forecasts')
    .select(
      'forecast_date, target_date, base_price, predicted, lower_band, upper_band, expert_grade, actual, actual_date, direction_hit, within_band, abs_pct_err',
    )
    .eq('ticker', ticker)
    .order('forecast_date', { ascending: false })
    .limit(40);
  return { calib, track: ((trackRows ?? []) as TrackRow[]).reverse() };
}

/** Latest Soros consensus within 3 days of the base date. */
async function fetchExpertSignal(
  sb: ReturnType<typeof createAdminClient>,
  ticker: string,
  lastKrDate: string,
  sigma: number,
  k: number,
): Promise<ExpertSignal | null> {
  const since = new Date(lastKrDate);
  since.setDate(since.getDate() - 3);
  const { data } = await sb
    .from('final_signals')
    .select('weighted_score, signal_grade, cycle_at')
    .eq('ticker', ticker)
    .gte('cycle_at', since.toISOString())
    .order('cycle_at', { ascending: false })
    .limit(1);
  if (!data || data.length === 0) return null;
  const row = data[0] as { weighted_score: number | null; signal_grade: string | null };
  if (row.weighted_score == null) return null;
  const score = Number(row.weighted_score);
  return { score, grade: row.signal_grade, tilt: k * (score / 2) * sigma };
}

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
    const lastDateStr = history[history.length - 1].date;
    const lastDate = new Date(lastDateStr);

    // Overnight US→KR open gap (level shift applied to every horizon).
    // Degrades to null if betas/US data unavailable.
    const overnight = await fetchOvernightSignal(ticker, lastDateStr, sigma);
    const gap = overnight?.gap ?? 0;

    // Forecast ledger: calibration (pooled) + this ticker's track record,
    // and the expert consensus that tilts today's drift. All degrade
    // gracefully (k=prior / empty track / no tilt) when unavailable.
    let calib: Calibration = {
      k: K_PRIOR,
      band_mult: 1.0,
      n_evaluated: 0,
      direction_hit_rate: null,
      coverage: null,
      median_abs_err: null,
    };
    let track: TrackRow[] = [];
    let expert: ExpertSignal | null = null;
    try {
      const sb = createAdminClient();
      const ledger = await fetchLedger(sb, ticker);
      calib = ledger.calib;
      track = ledger.track;
      expert = await fetchExpertSignal(sb, ticker, lastDateStr, sigma, calib.k);
    } catch {
      // service role not configured — pure statistical forecast
    }
    const tilt = expert?.tilt ?? 0;

    const forecast: ForecastPoint[] = [];
    for (let h = 1; h <= horizon; h++) {
      // The overnight gap is a one-time open jump, so it shifts the whole
      // forecast level by `gap` (not re-applied each day); drift (incl.
      // the calibrated expert tilt) accrues with h and the band widens
      // with √h around the shifted center.
      const logCenter = gap + (muEff + tilt) * h;
      const halfWidth = Z_95 * calib.band_mult * sigma * Math.sqrt(h);
      const center = lastClose * Math.exp(logCenter);
      const lower = lastClose * Math.exp(logCenter - halfWidth);
      const upper = lastClose * Math.exp(logCenter + halfWidth);
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
        track,
        meta: {
          ok: true,
          last_close: lastClose,
          drift_daily: muEff, // already shrunk
          drift_raw: muRaw,
          vol_daily: sigma,
          lookback_used: rets.length,
          horizon,
          expert: expert
            ? {
                score: expert.score,
                grade: expert.grade,
                tilt_daily: expert.tilt,
                tilt_total_pct: (Math.exp(expert.tilt * horizon) - 1) * 100,
              }
            : null,
          calibration: {
            k: calib.k,
            band_mult: calib.band_mult,
            n_evaluated: calib.n_evaluated,
            direction_hit_rate: calib.direction_hit_rate,
            coverage: calib.coverage,
            median_abs_err: calib.median_abs_err,
            learning: calib.n_evaluated >= MIN_CALIB_N, // k now data-driven
          },
          method: expert
            ? 'rw_drift_overnight_expert_v1'
            : overnight
              ? 'random_walk_drift_overnight_v1'
              : 'random_walk_drift_v1',
          overnight: overnight
            ? {
                us_symbol: overnight.us_symbol,
                beta: overnight.beta,
                correlation: overnight.correlation,
                r_squared: overnight.r_squared,
                us_return: overnight.us_return,
                us_date: overnight.us_date,
                gap_pct: (Math.exp(overnight.gap) - 1) * 100,
              }
            : null,
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
