'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts';
import { ClientOnly } from './client-only';
import { cn } from '@/lib/utils';

export type ScoreTrendPeriod = '1W' | '1M' | '3M' | '6M' | '1Y' | 'ALL';

const PERIOD_DAYS: Record<ScoreTrendPeriod, number> = {
  '1W': 7,
  '1M': 30,
  '3M': 90,
  '6M': 180,
  '1Y': 365,
  ALL: Number.POSITIVE_INFINITY,
};

const PERIODS: { id: ScoreTrendPeriod; label: string }[] = [
  { id: '1W', label: '1W' },
  { id: '1M', label: '1M' },
  { id: '3M', label: '3M' },
  { id: '6M', label: '6M' },
  { id: '1Y', label: '1Y' },
  { id: 'ALL', label: 'ALL' },
];

interface Point {
  date: string;
  final_score: number;
}

interface MLPrediction {
  target_date: string;
  predicted_score: number;
  lower_95: number | null;
  upper_95: number | null;
  /** Optional model identifier — surfaces honestly in the legend.
   *  e.g. 'gbr_r1' vs 'v1' vs 'OLS-fallback'. */
  model_version?: string | null;
}

interface ChartRow {
  date: string;
  actual: number | null;
  predicted: number | null;
  band_low: number | null;
  band_high: number | null;
  ma5: number | null;
  ma20: number | null;
  /** Normalized price (0..1) over the visible window — for the
   *  optional 'compare with stock price' overlay. Null when no
   *  price data exists for that day. */
  price_norm: number | null;
  /** Raw stock close (KRW) — surfaced in tooltip only. */
  price_raw: number | null;
  /** % change from the first available price in the window. */
  price_return: number | null;
  /** Naive 'predict = yesterday's score' baseline. Pinned in
   *  tooltip + drawn as a faint reference line. Lets users see
   *  whether the GBM/OLS predictor beats a no-skill baseline. */
  naive_predicted: number | null;
}

/** Centered SMA. Returns null for indices without enough history. */
function smaOfScores(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null) {
      sum += v;
      count += 1;
    }
    if (i >= window) {
      const dropped = values[i - window];
      if (dropped != null) {
        sum -= dropped;
        count -= 1;
      }
    }
    // Only emit once we've seen at least window/2 valid samples — avoids
    // a noisy MA20 line during the first 3-4 days of accumulation.
    if (i >= window - 1 && count >= Math.ceil(window / 2)) {
      out[i] = sum / count;
    }
  }
  return out;
}

/**
 * 5-business-day forecast with 95% prediction interval.
 *
 * Method:
 *   1. OLS slope on the last 7 history points.
 *   2. Residual stddev σ from the fitted line.
 *   3. Mean-reversion dampening: trend × 0.75ᵗ + 0.5 × (1 − 0.75ᵗ).
 *   4. PI half-width at horizon t:
 *        1.96 · σ · √(1 + 1/n + (x_t − x̄)² / Σ(x_i − x̄)²)
 *      Widens with distance and is shrunk by the same dampening factor
 *      that pulls the central estimate toward NEUTRAL — so a strongly
 *      reverting forecast also has a narrower band by construction.
 */
function buildForecast(
  history: Point[], horizonDays = 5,
): { mean: Point[]; lower: Point[]; upper: Point[]; fittedPast: Point[] } {
  const empty = {
    mean: [] as Point[], lower: [] as Point[], upper: [] as Point[],
    fittedPast: [] as Point[],
  };
  if (history.length < 4) return empty;

  const recent = history.slice(-7);
  const n = recent.length;
  const xs = recent.map((_, i) => i);
  const ys = recent.map((p) => p.final_score);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
  const sxy = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0);
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;

  // Residual stddev (degrees of freedom n-2)
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const ssr = residuals.reduce((acc, r) => acc + r * r, 0);
  const sigma = n > 2 ? Math.sqrt(ssr / (n - 2)) : 0.05;

  // Backcast: fitted line over the same history points used for the regression.
  // Anchors x=0..n-1 onto the *recent* slice, so the fitted curve sits under
  // the actual line and the user can read the residual (실측 − 예측) directly.
  const clip = (v: number) => Math.max(0, Math.min(1, v));
  const fittedPast: Point[] = recent.map((p, i) => ({
    date: p.date,
    final_score: clip(intercept + slope * i),
  }));

  const lastDate = new Date(history[history.length - 1].date);
  const mean: Point[] = [];
  const lower: Point[] = [];
  const upper: Point[] = [];

  let cursor = new Date(lastDate);
  let added = 0;
  while (added < horizonDays) {
    cursor = new Date(cursor.getTime() + 86400_000);
    const dow = cursor.getDay();
    if (dow === 0 || dow === 6) continue;
    added += 1;
    const x = n - 1 + added;
    const damp = Math.pow(0.75, added);
    const trend = intercept + slope * x;
    const projected = trend * damp + 0.5 * (1 - damp);

    // Prediction interval — std error widens with distance from training mean.
    const seFactor = Math.sqrt(
      1 + 1 / n + sxx > 0 ? (x - mx) ** 2 / sxx : 0,
    );
    const halfWidth = 1.96 * sigma * seFactor * damp;   // dampening narrows band too

    const date = cursor.toISOString().slice(0, 10);
    mean.push({ date, final_score: clip(projected) });
    lower.push({ date, final_score: clip(projected - halfWidth) });
    upper.push({ date, final_score: clip(projected + halfWidth) });
  }
  return { mean, lower, upper, fittedPast };
}

export function ScoreTrend({
  ticker,
  data,
  showForecast = true,
  mlPredictions,
  initialPeriod = '1M',
}: {
  ticker?: string;
  data: Point[];
  showForecast?: boolean;
  mlPredictions?: MLPrediction[];
  initialPeriod?: ScoreTrendPeriod;
}) {
  const [period, setPeriod] = useState<ScoreTrendPeriod>(initialPeriod);
  const [showMA, setShowMA] = useState(false);
  const [showGradeBands, setShowGradeBands] = useState(true);
  const [showPrice, setShowPrice] = useState(false);
  const [showNaive, setShowNaive] = useState(false);

  // Price overlay — fetch daily closes for the same ticker so users
  // can compare AI score motion with actual stock movement. We map
  // period → kr-chart period (close enough — kr-chart uses 1m/3m etc.
  // and we slice client-side by date afterward).
  const [priceByDate, setPriceByDate] = useState<Map<string, number>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!ticker || !showPrice) return;
    let cancelled = false;
    const krPeriod =
      period === '1W' ? '1m'  // 1W: just slice from 1M data
      : period === '1M' ? '1m'
      : period === '3M' ? '3m'
      : period === '6M' ? '1y'
      : period === '1Y' ? '1y'
      : '1y';
    fetch(`/api/kr-chart?ticker=${ticker}&period=${krPeriod}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: Array<{ date: string; close: number }> }) => {
        if (cancelled) return;
        const m = new Map<string, number>();
        for (const c of j.candles ?? []) {
          // The score data uses ISO date strings ('YYYY-MM-DD');
          // kr-chart returns the same for daily resolution.
          if (c.date && c.close != null) m.set(c.date.slice(0, 10), c.close);
        }
        setPriceByDate(m);
      })
      .catch(() => {
        if (!cancelled) setPriceByDate(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, showPrice, period]);

  // Slice the history to the chosen window. ALL keeps everything; the
  // rest count backward from the most recent point. OLS forecast still
  // uses the LAST 7 points of the sliced window so the band reflects
  // recent regime.
  const filteredData = (() => {
    if (data.length === 0) return data;
    const maxDays = PERIOD_DAYS[period];
    if (!Number.isFinite(maxDays)) return data;
    const newestTs = new Date(data[data.length - 1].date).getTime();
    const cutoff = newestTs - maxDays * 86400_000;
    return data.filter((p) => new Date(p.date).getTime() >= cutoff);
  })();
  // For the prediction series we also restrict to the same window —
  // future predictions stay (they're beyond newestTs), past
  // backcast/fitted is naturally constrained by `filteredData`.

  // Prefer ML-stored predictions if available; fall back to in-browser OLS.
  let mean: Point[] = [];
  let lower: Point[] = [];
  let upper: Point[] = [];
  let fittedPast: Point[] = [];
  let usingML = false;

  if (showForecast) {
    // Always compute the OLS fit — gives us the backcast/fitted line over
    // historical dates so the user can eyeball residuals vs the actual line.
    const ols = buildForecast(filteredData, 5);
    fittedPast = ols.fittedPast;

    if (mlPredictions && mlPredictions.length > 0) {
      usingML = true;
      mean = mlPredictions.map((p) => ({
        date: p.target_date,
        final_score: p.predicted_score,
      }));
      lower = mlPredictions.map((p) => ({
        date: p.target_date,
        final_score: p.lower_95 ?? p.predicted_score,
      }));
      upper = mlPredictions.map((p) => ({
        date: p.target_date,
        final_score: p.upper_95 ?? p.predicted_score,
      }));
    } else {
      mean = ols.mean;
      lower = ols.lower;
      upper = ols.upper;
    }
  }

  // Honest legend label: read the actual model_version (e.g. 'gbr_r1')
  // from the predictions when usingML; fall back to 'OLS 외삽' for the
  // in-browser linear fit. Prevents the misleading 'GBM ML' label when
  // the predictions are actually OLS.
  const modelLabel = usingML
    ? `예측 (${mlPredictions?.[0]?.model_version ?? 'ML'})`
    : '예측 (OLS 외삽)';

  // Build a date-keyed lookup for the fitted-past series so we can attach
  // a `predicted` value to every historical row (not just the last one).
  const fittedByDate = new Map(fittedPast.map((p) => [p.date, p.final_score]));

  // Moving averages over the actual-score series — smooths daily noise
  // so the trend is visible without staring at the raw scatter.
  const actualSeries = filteredData.map((p) => p.final_score);
  const ma5Series = smaOfScores(actualSeries, 5);
  const ma20Series = smaOfScores(actualSeries, 20);

  // Price overlay normalisation. Two side effects of the window-bound
  // min-max approach previously: (1) the line crashed to 0 / shot to
  // 1 making it visually dominate, (2) users couldn't tell whether
  // price moved 1% or 50%. We now compute BOTH:
  //   • priceNormByDate — for the line position (still 0..1 over the
  //     score axis, but inset to the 0.05..0.95 band so it doesn't
  //     touch the y-axis extremes)
  //   • priceReturnByDate — % change from window's first price, for
  //     the tooltip and the new 'period return' badge
  const { priceNormByDate, priceRawByDate, priceReturnByDate, priceWindowReturn } = useMemo(() => {
    const emptyResult = {
      priceNormByDate: new Map<string, number>(),
      priceRawByDate: new Map<string, number>(),
      priceReturnByDate: new Map<string, number>(),
      priceWindowReturn: null as number | null,
    };
    if (priceByDate.size === 0 || filteredData.length === 0) return emptyResult;
    const samples: Array<{ date: string; price: number }> = [];
    for (const p of filteredData) {
      const v = priceByDate.get(p.date.slice(0, 10));
      if (v != null) samples.push({ date: p.date, price: v });
    }
    if (samples.length === 0) return emptyResult;
    const prices = samples.map((s) => s.price);
    const start = prices[0];
    const end = prices[prices.length - 1];

    // PROPORTIONAL-MOVE normalisation (replaces the previous min-max
    // stretch). User insight: a 3% price move was filling the whole
    // y-axis because min-max scaled the smallest range to 0..1. Now
    // we anchor the overlay to the SCORE's starting value and apply
    // the price's % change at each step:
    //   overlay[i] = scoreStart × (1 + (price[i]/price[0] − 1))
    // So a 0% price move leaves the line flat at scoreStart, a -12%
    // move drops it ~12% from scoreStart, etc. Same proportional
    // semantics as the score motion so the comparison is honest.
    // Clamped to [0.01, 0.99] so extreme moves don't escape the axis.
    const scoreStart = filteredData[0]?.final_score ?? 0.5;
    const norm = new Map<string, number>();
    const raw = new Map<string, number>();
    const ret = new Map<string, number>();
    for (const s of samples) {
      const priceRatio = s.price / start;
      const overlay = scoreStart * priceRatio;
      norm.set(s.date, Math.max(0.01, Math.min(0.99, overlay)));
      raw.set(s.date, s.price);
      ret.set(s.date, ((s.price - start) / start) * 100);
    }
    const windowReturn = ((end - start) / start) * 100;
    return {
      priceNormByDate: norm,
      priceRawByDate: raw,
      priceReturnByDate: ret,
      priceWindowReturn: windowReturn,
    };
  }, [priceByDate, filteredData]);

  // Score variability — raw standard deviation expressed as % of the
  // full score range (0..1). For a [0,1]-bounded score, annualised
  // log-return volatility doesn't apply; instead we report 'how much
  // does the daily score swing relative to the full range':
  //   stdev 0.05 → '변동성 5%'  (small swings)
  //   stdev 0.20 → '변동성 20%' (volatile)
  //   stdev 0.40 → '변동성 40%' (extreme — uses most of the [0,1] band)
  const scoreVolatility = useMemo(() => {
    if (actualSeries.length < 5) return null;
    const valid = actualSeries.filter((v): v is number => v != null);
    if (valid.length < 5) return null;
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    const variance = valid.reduce((acc, v) => acc + (v - mean) ** 2, 0) / valid.length;
    return Math.min(1, Math.sqrt(variance));   // raw stdev, capped at 1.0
  }, [actualSeries]);

  // Merge into one array per Recharts.
  // - History rows: actual = real score, predicted = OLS-fitted value (if available).
  // - Forecast rows: actual = null, predicted = projection.
  // - `residual` and `residual_pct` are derived for tooltip readout.
  const merged: (ChartRow & { residual: number | null; residual_pct: number | null })[] = [
    ...filteredData.map((p, i) => {
      const fitted = fittedByDate.get(p.date) ?? null;
      // Make the forecast line connect by setting predicted on the last
      // history point even if it's outside the OLS window.
      const predicted =
        fitted !== null
          ? fitted
          : i === filteredData.length - 1 && mean.length > 0
            ? p.final_score
            : null;
      const residual = predicted !== null ? p.final_score - predicted : null;
      const residual_pct =
        predicted !== null && predicted !== 0
          ? ((p.final_score - predicted) / predicted) * 100
          : null;
      // Naive baseline: predict today = yesterday's score. The
      // simplest possible 'predictor' a real model must beat to add
      // any value. For day 0 of the window, leave null.
      const naive = i > 0 ? filteredData[i - 1].final_score : null;
      return {
        date: p.date,
        actual: p.final_score,
        predicted,
        band_low: i === filteredData.length - 1 && lower.length > 0 ? p.final_score : null,
        band_high: i === filteredData.length - 1 && upper.length > 0 ? p.final_score : null,
        ma5: ma5Series[i],
        ma20: ma20Series[i],
        price_norm: priceNormByDate.get(p.date) ?? null,
        price_raw: priceRawByDate.get(p.date) ?? null,
        price_return: priceReturnByDate.get(p.date) ?? null,
        naive_predicted: naive,
        residual,
        residual_pct,
      };
    }),
    ...mean.map((p, i) => ({
      date: p.date,
      actual: null,
      predicted: p.final_score,
      band_low: lower[i]?.final_score ?? null,
      band_high: upper[i]?.final_score ?? null,
      ma5: null,
      ma20: null,
      price_norm: null,
      price_raw: null,
      price_return: null,
      naive_predicted: null,
      residual: null,
      residual_pct: null,
    })),
  ];

  // MAE / MAPE over the overlap so the legend can show overall fit quality.
  const overlap = merged.filter(
    (r) => r.actual !== null && r.predicted !== null && r.residual !== null,
  );
  const mae =
    overlap.length > 0
      ? overlap.reduce((acc, r) => acc + Math.abs(r.residual as number), 0) /
        overlap.length
      : null;
  const mape =
    overlap.length > 0
      ? overlap.reduce(
          (acc, r) =>
            acc +
            Math.abs(
              ((r.actual as number) - (r.predicted as number)) /
                Math.max(0.01, Math.abs(r.actual as number)),
            ),
          0,
        ) /
        overlap.length *
        100
      : null;

  // Directional accuracy — of the day-to-day deltas where both actual
  // and predicted exist, what % had matching sign? This is the metric
  // that actually tells you if the model "predicts up vs down" rather
  // than just hugging the mean. A flat model can have low MAPE but
  // ~50% directional accuracy (coin flip).
  const directionalAcc = (() => {
    if (overlap.length < 2) return null;
    let matches = 0;
    let total = 0;
    for (let i = 1; i < overlap.length; i++) {
      const prevActual = overlap[i - 1].actual as number;
      const prevPred = overlap[i - 1].predicted as number;
      const curActual = overlap[i].actual as number;
      const curPred = overlap[i].predicted as number;
      const actualDelta = curActual - prevActual;
      const predDelta = curPred - prevPred;
      // Skip flat days where direction is undefined (|delta| < 0.005)
      if (Math.abs(actualDelta) < 0.005 || Math.abs(predDelta) < 0.005) continue;
      total += 1;
      if ((actualDelta > 0) === (predDelta > 0)) matches += 1;
    }
    return total > 0 ? (matches / total) * 100 : null;
  })();

  // Composite reliability — weighted blend of three signals, each in [0,100].
  //  • sample size: how much overlap we have (0 → 0%, 14+ → 100%)
  //  • MAPE inverse: 0% MAPE → 100, 30%+ MAPE → 0
  //  • directional accuracy: as-is in 0..100
  const reliability = (() => {
    if (overlap.length === 0 || mape == null) return null;
    const sampleSignal = Math.min(100, (overlap.length / 14) * 100);
    const mapeSignal = Math.max(0, 100 - (mape / 30) * 100);
    const dirSignal = directionalAcc ?? 50;
    return 0.3 * sampleSignal + 0.35 * mapeSignal + 0.35 * dirSignal;
  })();

  const reliabilityTier =
    reliability == null
      ? null
      : reliability >= 70
        ? 'high'
        : reliability >= 50
          ? 'medium'
          : 'low';

  // Naive-baseline MAE — how much error does 'predict = yesterday'
  // produce on the same overlap? A useful predictor must beat this.
  const naiveMae = useMemo(() => {
    if (filteredData.length < 2) return null;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < filteredData.length; i++) {
      const cur = filteredData[i].final_score;
      const prev = filteredData[i - 1].final_score;
      sum += Math.abs(cur - prev);
      count += 1;
    }
    return count > 0 ? sum / count : null;
  }, [filteredData]);

  // Skill score — positive means GBM beats naive, negative means worse.
  // Formula: 1 − (modelMAE / naiveMAE). Standard meteorological skill.
  const skillScore =
    mae != null && naiveMae != null && naiveMae > 0
      ? 1 - mae / naiveMae
      : null;

  // ─── Score ↔ Price relationship metrics ──────────────────────────
  // Only computed when price data is loaded. Answers "does the AI
  // score actually relate to real price action?" — the key question
  // a user asks when score and price lines diverge visually.
  //
  //   • scorePriceCorr   — Pearson on level series (score, price). −1..+1.
  //                        Tells whether high-score days were also high-price days.
  //   • scorePriceDirAcc — % of day-over-day moves where the SIGN of
  //                        ΔScore matched the SIGN of ΔPrice. The
  //                        "does score predict direction" metric.
  //   • leadDays         — lag k (1..3) that maximises corr(score_t, price_{t+k}).
  //                        Positive means score leads price by k days.
  const priceMetrics = useMemo(() => {
    const empty = {
      scorePriceCorr: null as number | null,
      scorePriceDirAcc: null as number | null,
      leadDays: null as number | null,
      leadCorr: null as number | null,
      sampleSize: 0,
    };
    if (priceByDate.size === 0 || filteredData.length < 5) return empty;

    // Aligned series: only days where BOTH score and price exist.
    const pairs: Array<{ date: string; score: number; price: number }> = [];
    for (const p of filteredData) {
      const px = priceByDate.get(p.date.slice(0, 10));
      if (px != null) pairs.push({ date: p.date, score: p.final_score, price: px });
    }
    if (pairs.length < 5) return empty;

    const pearson = (xs: number[], ys: number[]): number | null => {
      const n = Math.min(xs.length, ys.length);
      if (n < 3) return null;
      const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
      const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
      let num = 0;
      let dx2 = 0;
      let dy2 = 0;
      for (let i = 0; i < n; i++) {
        const dx = xs[i] - mx;
        const dy = ys[i] - my;
        num += dx * dy;
        dx2 += dx * dx;
        dy2 += dy * dy;
      }
      const denom = Math.sqrt(dx2 * dy2);
      return denom > 0 ? num / denom : null;
    };

    const scores = pairs.map((p) => p.score);
    const prices = pairs.map((p) => p.price);
    const scorePriceCorr = pearson(scores, prices);

    // Directional accuracy on day-over-day moves.
    let dirMatch = 0;
    let dirTotal = 0;
    for (let i = 1; i < pairs.length; i++) {
      const dScore = pairs[i].score - pairs[i - 1].score;
      const dPrice = pairs[i].price - pairs[i - 1].price;
      // Skip days with near-zero score move (no directional signal).
      if (Math.abs(dScore) < 0.01) continue;
      dirTotal += 1;
      if ((dScore > 0) === (dPrice > 0)) dirMatch += 1;
    }
    const scorePriceDirAcc = dirTotal >= 3 ? (dirMatch / dirTotal) * 100 : null;

    // Lead-lag scan: try lag 0..3 (score leads price by k days), pick max |corr|.
    let bestLag = 0;
    let bestCorr = scorePriceCorr ?? 0;
    if (pairs.length >= 8) {
      for (let k = 1; k <= 3; k++) {
        if (pairs.length - k < 5) break;
        const sLag = scores.slice(0, pairs.length - k);
        const pLag = prices.slice(k);
        const c = pearson(sLag, pLag);
        if (c !== null && Math.abs(c) > Math.abs(bestCorr)) {
          bestCorr = c;
          bestLag = k;
        }
      }
    }
    return {
      scorePriceCorr,
      scorePriceDirAcc,
      leadDays: bestLag > 0 ? bestLag : null,
      leadCorr: bestLag > 0 ? bestCorr : null,
      sampleSize: pairs.length,
    };
  }, [priceByDate, filteredData]);

  return (
    <div className="w-full">
     {/* Period filter row + indicator toggles. */}
     <div className="mb-3 flex items-center justify-between gap-2 flex-wrap">
       <div className="flex items-center gap-1.5 flex-wrap">
         {/* Period segmented */}
         <div className="flex rounded-md bg-bg-secondary/40 p-0.5 border border-border-subtle/40">
           {PERIODS.map((p) => (
             <button
               key={p.id}
               type="button"
               onClick={() => setPeriod(p.id)}
               className={cn(
                 'px-2.5 py-1 text-[11px] font-semibold transition-all rounded',
                 period === p.id
                   ? 'bg-brand-purple text-white shadow-sm'
                   : 'text-txt-secondary hover:text-txt-primary',
               )}
             >
               {p.label}
             </button>
           ))}
         </div>

         {/* MA toggle — smooths the actual score with 5/20-day SMA */}
         <button
           type="button"
           onClick={() => setShowMA((v) => !v)}
           className={cn(
             'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
             showMA
               ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
               : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
           )}
           title="5일/20일 이동평균선으로 점수 추세 평활화"
         >
           MA
         </button>

         {/* Grade band toggle — colored background tiers */}
         <button
           type="button"
           onClick={() => setShowGradeBands((v) => !v)}
           className={cn(
             'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
             showGradeBands
               ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
               : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
           )}
           title="5단계 신호 등급 구간 (강한 관심/관심/관망/주의/위험) 배경 표시"
         >
           등급띠
         </button>

         {/* Price overlay toggle — fetches daily closes for ticker */}
         {ticker && (
           <button
             type="button"
             onClick={() => setShowPrice((v) => !v)}
             className={cn(
               'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
               showPrice
                 ? 'border-status-info/40 bg-status-info/10 text-status-info'
                 : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
             )}
             title="실제 종목 가격 변동을 점수 차트 위에 normalize해서 overlay (점수 vs 실제 주가)"
           >
             주가 비교
           </button>
         )}

         {/* Naive baseline toggle */}
         <button
           type="button"
           onClick={() => setShowNaive((v) => !v)}
           className={cn(
             'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
             showNaive
               ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
               : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
           )}
           title="Naive baseline: '내일 점수 = 오늘 점수' 라는 가장 단순한 예측. ML 모델은 이걸 못 이기면 가치 없음 (위 skill 지표가 이 baseline 대비 우위)."
         >
           Naive
         </button>
       </div>
       <div className="flex items-center gap-3 flex-wrap">
         {/* Price window-return badge — only shown when 주가 비교 ON */}
         {showPrice && priceWindowReturn !== null && (
           <span
             className="text-[10px] text-txt-muted"
             title="선택 기간 첫 거래일 대비 가장 최근 거래일의 종가 변동률"
           >
             기간 수익률{' '}
             <span
               className="font-mono tabular-nums font-medium"
               style={{
                 color:
                   priceWindowReturn >= 0
                     ? 'rgb(72,166,152)'
                     : 'rgb(220,72,72)',
               }}
             >
               {priceWindowReturn >= 0 ? '+' : ''}
               {priceWindowReturn.toFixed(2)}%
             </span>
           </span>
         )}
         {/* Variability badge — stdev × 100, capped 0~100% */}
         {scoreVolatility !== null && (
           <span
             className="text-[10px] text-txt-muted"
             title="점수 시계열의 표준편차 (× 100). 5% = 안정, 20%+ = 변동 큼."
           >
             변동성{' '}
             <span
               className="font-mono tabular-nums font-medium"
               style={{
                 color:
                   scoreVolatility >= 0.20
                     ? 'rgb(220,72,72)'
                     : scoreVolatility >= 0.10
                       ? 'rgb(233,178,71)'
                       : 'var(--text-primary)',
               }}
             >
               {(scoreVolatility * 100).toFixed(1)}%
             </span>
           </span>
         )}
         <div className="text-[10px] text-txt-muted">
           실측 {filteredData.length}일 · 예측 {mean.length}일
         </div>
       </div>
     </div>

     {mae !== null && mape !== null && (
       <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--text-secondary)]">
         <span className="text-txt-muted">
           예측 적합도 ({overlap.length}일 비교):
         </span>
         <span>
           MAE <span className="text-[color:var(--text-primary)] font-mono tabular-nums font-medium">{mae.toFixed(3)}</span>
         </span>
         <span>
           MAPE <span className="text-[color:var(--text-primary)] font-mono tabular-nums font-medium">{mape.toFixed(1)}%</span>
         </span>
         {directionalAcc !== null && (
           <span>
             방향 일치{' '}
             <span
               className="font-mono tabular-nums font-medium"
               style={{
                 color:
                   directionalAcc >= 60
                     ? 'rgb(72,166,152)'
                     : directionalAcc < 50
                       ? 'rgb(220,72,72)'
                       : 'var(--text-primary)',
               }}
               title="day-over-day 점수 변동 방향이 일치한 비율 (50% = coin flip)"
             >
               {directionalAcc.toFixed(0)}%
             </span>
           </span>
         )}
         {skillScore !== null && (
           <span title="모델 MAE vs naive baseline MAE. 양수 = 모델이 naive를 이김, 음수 = 모델 무용.">
             skill{' '}
             <span
               className="font-mono tabular-nums font-medium"
               style={{
                 color:
                   skillScore >= 0.2
                     ? 'rgb(72,166,152)'
                     : skillScore < 0
                       ? 'rgb(220,72,72)'
                       : 'var(--text-primary)',
               }}
             >
               {skillScore >= 0 ? '+' : ''}
               {(skillScore * 100).toFixed(0)}%
             </span>
           </span>
         )}
         {reliability !== null && reliabilityTier && (
           <span
             className={cn(
               'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ml-auto',
               reliabilityTier === 'high'
                 ? 'bg-status-success/15 text-status-success'
                 : reliabilityTier === 'medium'
                   ? 'bg-status-warning/15 text-status-warning'
                   : 'bg-status-danger/15 text-status-danger',
             )}
             title="샘플수(30%) + MAPE(35%) + 방향일치(35%) 가중합 신뢰도"
           >
             신뢰도{' '}
             {reliabilityTier === 'high'
               ? '높음'
               : reliabilityTier === 'medium'
                 ? '보통'
                 : '낮음'}{' '}
             ({Math.round(reliability)})
           </span>
         )}
       </div>
     )}

     {/* Score ↔ Price relationship metrics — only when 주가 비교 ON.
         Answers "do the AI score and real price actually move together?"
         which is the question users ask when the two lines diverge. */}
     {showPrice && priceMetrics.scorePriceCorr !== null && (
       <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--text-secondary)] rounded-md bg-status-info/[0.04] border border-status-info/15 px-3 py-1.5">
         <span className="text-status-info font-semibold">
           점수 ↔ 주가 ({priceMetrics.sampleSize}일):
         </span>
         <span title="Pearson 상관계수. +1: 완벽 동조, 0: 무관, −1: 정반대. |값| ≥ 0.5면 의미 있음.">
           상관계수{' '}
           <span
             className="font-mono tabular-nums font-medium"
             style={{
               color:
                 Math.abs(priceMetrics.scorePriceCorr) >= 0.5
                   ? 'rgb(72,166,152)'
                   : Math.abs(priceMetrics.scorePriceCorr) < 0.2
                     ? 'rgb(220,72,72)'
                     : 'var(--text-primary)',
             }}
           >
             {priceMetrics.scorePriceCorr >= 0 ? '+' : ''}
             {priceMetrics.scorePriceCorr.toFixed(2)}
           </span>
         </span>
         {priceMetrics.scorePriceDirAcc !== null && (
           <span title="점수가 오른 다음날 주가도 올랐는지의 비율. 50%는 동전 던지기 수준.">
             방향 일치{' '}
             <span
               className="font-mono tabular-nums font-medium"
               style={{
                 color:
                   priceMetrics.scorePriceDirAcc >= 60
                     ? 'rgb(72,166,152)'
                     : priceMetrics.scorePriceDirAcc < 50
                       ? 'rgb(220,72,72)'
                       : 'var(--text-primary)',
               }}
             >
               {priceMetrics.scorePriceDirAcc.toFixed(0)}%
             </span>
           </span>
         )}
         {priceMetrics.leadDays !== null && priceMetrics.leadCorr !== null && (
           <span title="점수가 N일 앞서 주가를 예측했을 때의 최고 상관도. 선행성이 있으면 모델 가치 ↑.">
             선행성{' '}
             <span
               className="font-mono tabular-nums font-medium"
               style={{
                 color:
                   Math.abs(priceMetrics.leadCorr) >= 0.5
                     ? 'rgb(72,166,152)'
                     : 'var(--text-primary)',
               }}
             >
               +{priceMetrics.leadDays}일 ({priceMetrics.leadCorr >= 0 ? '+' : ''}
               {priceMetrics.leadCorr.toFixed(2)})
             </span>
           </span>
         )}
         {Math.abs(priceMetrics.scorePriceCorr) < 0.2 && (
           <span className="text-status-warning text-[10px] ml-auto">
             ⚠ 점수와 주가가 거의 무관함 — 모델 재학습 검토
           </span>
         )}
       </div>
     )}

     {/* Low-reliability banner — informational, doesn't hide the chart */}
     {reliabilityTier === 'low' && (
       <div className="mb-2 rounded-md border border-status-warning/30 bg-status-warning/[0.06] px-3 py-2 text-[11px] text-status-warning flex items-start gap-2">
         <span aria-hidden>ⓘ</span>
         <span className="leading-relaxed">
           예측 신뢰도 낮음 — 학습 데이터 부족 또는 모델이 평균 회귀에 가까운 상태입니다.
           {overlap.length < 7 && ' 데이터 누적 후 다시 평가하세요.'}
           {directionalAcc !== null && directionalAcc < 50 && ' 방향성 예측이 coin flip 이하입니다.'}
         </span>
       </div>
     )}
     <div className="h-56 w-full">
     <ClientOnly>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <ComposedChart data={merged} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <defs>
            <linearGradient id="forecastBand" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FF902F" stopOpacity={0.20} />
              <stop offset="100%" stopColor="#FF902F" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis
            dataKey="date"
            tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
            tickFormatter={(v) => v.slice(5)}
          />
          <YAxis domain={[0, 1]} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
          <Tooltip
            cursor={{
              // Brand-purple crosshair — consistent with the stock /
              // fullscreen chart cursors so users get the same visual
              // affordance everywhere.
              stroke: 'rgb(114,60,235)',
              strokeWidth: 1.4,
              strokeOpacity: 0.85,
              strokeDasharray: '4 3',
            }}
            content={({ active, payload, label }) => {
              if (!active || !payload || payload.length === 0) return null;
              const row = payload[0]?.payload as
                | (ChartRow & { residual: number | null; residual_pct: number | null })
                | undefined;
              if (!row) return null;
              const fmt = (v: number | null, digits = 3) =>
                v === null ? '—' : v.toFixed(digits);
              const signed = (v: number | null, digits = 3) =>
                v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}`;
              return (
                <div
                  style={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 8,
                    fontSize: 12,
                    padding: '8px 10px',
                    minWidth: 160,
                  }}
                >
                  <div style={{ marginBottom: 4, color: 'var(--text-secondary)' }}>{label}</div>
                  <div>실측: <b>{fmt(row.actual)}</b></div>
                  <div>예측: <b>{fmt(row.predicted)}</b></div>
                  {row.naive_predicted !== null && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                      Naive: {fmt(row.naive_predicted)}
                    </div>
                  )}
                  {row.residual !== null && (
                    <>
                      <div>
                        오차(실측−예측): <b>{signed(row.residual)}</b>
                      </div>
                      <div>
                        오차율: <b>{signed(row.residual_pct, 1)}%</b>
                      </div>
                    </>
                  )}
                  {row.band_low !== null && row.band_high !== null && (
                    <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
                      95% 구간: {fmt(row.band_low)} ~ {fmt(row.band_high)}
                    </div>
                  )}
                  {/* Price block — shown only when 주가 비교 ON */}
                  {row.price_raw !== null && (
                    <div
                      style={{
                        marginTop: 6,
                        paddingTop: 6,
                        borderTop: '1px solid var(--border-subtle)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <div>
                        종가:{' '}
                        <b style={{ color: 'var(--text-primary)' }}>
                          {row.price_raw.toLocaleString('ko-KR')}원
                        </b>
                      </div>
                      {row.price_return !== null && (
                        <div>
                          기간 수익률:{' '}
                          <b
                            style={{
                              color:
                                row.price_return >= 0
                                  ? 'rgb(72,166,152)'
                                  : 'rgb(220,72,72)',
                            }}
                          >
                            {row.price_return >= 0 ? '+' : ''}
                            {row.price_return.toFixed(2)}%
                          </b>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            }}
          />
          {/* Signal grade tier bands — colored background zones that
              instantly map score-y to a verdict (강한 관심 / 관심 /
              관망 / 주의 / 위험). Each <ReferenceArea> spans the full
              x-axis at low fillOpacity so the score lines stay
              dominant. Toggleable via the '등급띠' button. */}
          {showGradeBands && (
            <>
              {/* 강한 관심 ≥ 0.80 */}
              <ReferenceLine
                y={0.80}
                stroke="rgba(72,166,152,0.55)"
                strokeDasharray="4 4"
                ifOverflow="extendDomain"
              />
              {/* 관심 0.65-0.80 */}
              <ReferenceLine
                y={0.65}
                stroke="rgba(124,201,126,0.55)"
                strokeDasharray="4 4"
              />
              {/* 관망 / 주의 boundary at 0.35 */}
              <ReferenceLine
                y={0.35}
                stroke="rgba(233,178,71,0.55)"
                strokeDasharray="4 4"
              />
              {/* 위험 ≤ 0.20 */}
              <ReferenceLine
                y={0.20}
                stroke="rgba(220,72,72,0.55)"
                strokeDasharray="4 4"
              />
            </>
          )}
          {!showGradeBands && (
            <>
              <ReferenceLine y={0.65} stroke="rgba(114,60,235,0.45)" strokeDasharray="4 4" />
              <ReferenceLine y={0.35} stroke="rgba(239,68,68,0.45)" strokeDasharray="4 4" />
            </>
          )}
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            iconType="plainline"
            content={(props: unknown) => (
              <LegendWithPopover
                raw={props}
                modelLabel={modelLabel}
                overlapDays={overlap.length}
              />
            )}
          />

          {/* Confidence band — Area painted between band_low and band_high.
              Recharts pattern: use two stacked Areas or a base+delta pair. */}
          {showForecast && upper.length > 0 && (
            <>
              <Area
                type="monotone"
                dataKey="band_high"
                stroke="none"
                fill="url(#forecastBand)"
                fillOpacity={1}
                connectNulls={false}
                isAnimationActive={false}
                name="band_high"
                activeDot={false}
              />
              <Area
                type="monotone"
                dataKey="band_low"
                stroke="none"
                fill="var(--bg-secondary)"
                fillOpacity={1}
                connectNulls={false}
                isAnimationActive={false}
                legendType="none"
                tooltipType="none"
              />
            </>
          )}

          <Line
            type="monotone"
            dataKey="actual"
            stroke="#723CEB"
            strokeWidth={2}
            dot={{ r: 2.5, fill: '#723CEB' }}
            activeDot={{ r: 4 }}
            connectNulls={false}
            name="actual"
            isAnimationActive={false}
          />
          {showForecast && (mean.length > 0 || fittedPast.length > 0) && (
            <Line
              type="monotone"
              dataKey="predicted"
              stroke="#FF902F"
              strokeWidth={2}
              strokeDasharray="6 4"
              dot={{ r: 2.5, fill: '#FF902F' }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              name="predicted"
              isAnimationActive={false}
            />
          )}
          {/* Score MA — overlays a smoothed view of the actual score so
              users can see the underlying trend without daily noise.
              MA5 = short-term, MA20 = long-term, both render thinner
              than the raw line to stay subordinate. */}
          {showMA && (
            <>
              <Line
                type="monotone"
                dataKey="ma5"
                stroke="#F59E0B"
                strokeWidth={1.2}
                dot={false}
                activeDot={false}
                connectNulls
                name="ma5"
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="ma20"
                stroke="#A855F7"
                strokeWidth={1.2}
                dot={false}
                activeDot={false}
                connectNulls
                name="ma20"
                isAnimationActive={false}
              />
            </>
          )}

          {/* Price overlay — normalized to the score Y axis (0..1)
              within the visible window. Lets users SEE whether AI
              score motion correlates with actual stock movement. */}
          {showPrice && (
            <Line
              type="monotone"
              dataKey="price_norm"
              stroke="rgb(91,168,242)"
              strokeWidth={1.5}
              strokeOpacity={0.85}
              dot={false}
              activeDot={{ r: 3, fill: 'rgb(91,168,242)' }}
              connectNulls
              name="price_norm"
              isAnimationActive={false}
            />
          )}

          {/* Naive baseline — 'predict = yesterday's actual'. Drawn as
              a faint thin line for quick eyeball comparison with the
              GBM/OLS predicted line. Skill = 1 − MAE/naiveMAE. */}
          {showNaive && (
            // Theme-aware grey via CSS var so it's visible on light AND
            // dark backgrounds (previous rgba(255,255,255,0.45) was
            // invisible on the light cream chart canvas).
            <Line
              type="monotone"
              dataKey="naive_predicted"
              stroke="var(--text-muted)"
              strokeWidth={1.25}
              strokeDasharray="4 3"
              strokeOpacity={0.7}
              dot={false}
              activeDot={{ r: 3 }}
              connectNulls
              name="naive_predicted"
              isAnimationActive={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
     </ClientOnly>
     </div>
    </div>
  );
}

// ─── Legend with hover popovers ─────────────────────────────
// Each legend item explains, on hover:
//   • What data sources back the line
//   • How the value is computed
//   • What it represents in interpretation
// Lets users self-serve "이 점수가 어떻게 만들어지는 건지?" without
// leaving the chart.

interface LegendInfo {
  /** Heading shown at the top of the popover */
  title: string;
  /** What the line/area actually represents */
  what: string;
  /** Data sources or formula used to compute it */
  how: string[];
  /** How to read this in context of the chart */
  read?: string;
}

function buildLegendInfo(modelLabel: string, overlapDays: number): Record<string, LegendInfo> {
  return {
    actual: {
      title: '실측 점수',
      what: '매일 06:00 KST에 산출된 실제 AI 종합 점수 (0.0 ~ 1.0).',
      how: [
        '입력: 미국장 마감 시세 + 글로벌 거시 지표',
        '입력: KR 뉴스 감성 분석 (Claude Sonnet)',
        '입력: 6 voters(그레이엄·다우·터링·시러·케인즈·탈레브) 의견',
        '입력: RAG 청크 매칭 (섹터·종목 관련 시나리오)',
        '출력: 종합 점수 → 5단계 신호 (강한관심·관심·관망·주의·위험)',
      ],
      read: '확정된 분석 결과. 이미 발생한 날의 점수이며 변하지 않아요.',
    },
    predicted: {
      title: `예측 점수 (${modelLabel.replace('예측 (', '').replace(')', '')})`,
      what: '모델이 추정한 점수의 흐름. 과거(backcast) + 미래 5영업일(forecast).',
      how: [
        '모델: GradientBoostingRegressor (사이킷런)',
        '학습 데이터: 최근 120일 (~4개월) 실측 점수',
        '특성: 점수 시계열, 거래량 추세, 거시 변동 등',
        '과거 구간 = 회고 검증 (실측과 비교해 오차 측정)',
        '미래 구간 = 5영업일 추정 (월~금 다음 거래일)',
      ],
      read: '실측선과 가까울수록 모델이 잘 학습된 상태. 위의 MAE/MAPE/skill 지표 함께 보세요.',
    },
    naive_predicted: {
      title: '순진 baseline (어제 = 오늘)',
      what: '"내일 점수 = 오늘 점수" 가정한 가장 단순한 예측.',
      how: [
        '공식: naive[t] = actual[t-1] (전일 점수 그대로)',
        '추가 입력·계산 없음',
        '"이 모델 가치 있나?" 판단의 기준선',
        'Skill score = 1 − (모델MAE / naive MAE)',
      ],
      read: 'AI 예측이 이 선을 충분히 못 이기면 굳이 ML 쓸 가치 없음. Skill +20% 이상 권장.',
    },
    band_high: {
      title: '95% 신뢰구간',
      what: '예측의 불확실성 범위 — 95% 확률로 실제값이 이 안에 위치.',
      how: [
        '모델 잭나이프 또는 분산 추정 기반',
        '구간 폭이 좁을수록 모델 확신도 ↑',
        '미래로 갈수록 자연스럽게 넓어짐 (누적 불확실성)',
        '주황색 음영 영역으로 시각화',
      ],
      read: '구간이 등급 경계(0.65 / 0.35)를 넘나들면 결과 신호가 바뀔 수도 있다는 뜻.',
    },
    ma5: {
      title: 'MA5 (5일 이동평균선)',
      what: '실측 점수의 5일 단순 이동평균.',
      how: [
        '공식: MA5[t] = mean(actual[t-4..t])',
        '점수 단기 추세를 부드럽게 표현',
        '데이터 부족 시 (5일 미만) 렌더링 안 됨',
      ],
      read: 'MA5가 우상향 = 단기 점수 상승세. MA20과 교차하면 추세 전환 가능 신호.',
    },
    ma20: {
      title: 'MA20 (20일 이동평균선)',
      what: '실측 점수의 20일 단순 이동평균.',
      how: [
        '공식: MA20[t] = mean(actual[t-19..t])',
        '점수 중기 추세 기준선',
        '~1개월 평균 점수 레벨',
      ],
      read: 'MA20 위 = 평균보다 강한 점수. 가격의 MA20과 함께 보면 더 강력.',
    },
    price_norm: {
      title: '주가 (정규화)',
      what: '실제 종목 가격을 점수 시작값에 비례 변환해서 overlay.',
      how: [
        '데이터 소스: NAVER 일봉 (api.stock.naver.com)',
        '공식: overlay[i] = scoreStart × (price[i] / price[0])',
        '가격이 0% 변하면 직선, 12% 떨어지면 12% 비례 하락',
        '점수와 같은 단위로 비교 가능하도록 정규화',
      ],
      read: '점수와 주가가 같은 방향으로 움직이는지 확인. 점수가 1~3일 앞서 움직이면 선행지표.',
    },
  };
}

interface LegendPayloadItem {
  dataKey?: string;
  value?: string;
  color?: string;
  payload?: { stroke?: string; strokeDasharray?: string };
}

function LegendWithPopover({
  raw,
  modelLabel,
  overlapDays,
}: {
  raw: unknown;
  modelLabel: string;
  overlapDays: number;
}) {
  const r = raw as { payload?: LegendPayloadItem[] } | null;
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const info = useMemo(
    () => buildLegendInfo(modelLabel, overlapDays),
    [modelLabel, overlapDays],
  );
  if (!r?.payload || r.payload.length === 0) return null;
  const labelFor = (key: string): string => {
    if (key === 'actual') return '실측 점수';
    if (key === 'predicted') return modelLabel;
    if (key === 'naive_predicted') return '순진 baseline (어제=오늘)';
    if (key === 'band_high') return '95% 신뢰구간';
    if (key === 'ma5') return 'MA5';
    if (key === 'ma20') return 'MA20';
    if (key === 'price_norm') return '주가 (정규화)';
    return key;
  };
  return (
    <ul
      className="recharts-default-legend"
      style={{ padding: 0, margin: 0, textAlign: 'center', position: 'relative' }}
    >
      {r.payload.map((item) => {
        const key = item.dataKey ?? '';
        const detail = info[key];
        const isHovered = hoveredKey === key;
        return (
          <li
            key={key}
            onMouseEnter={() => setHoveredKey(key)}
            onMouseLeave={() => setHoveredKey(null)}
            style={{
              display: 'inline-block',
              marginRight: 10,
              position: 'relative',
              cursor: detail ? 'help' : 'default',
            }}
          >
            {/* SVG icon — match Recharts default appearance */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 32 32"
              style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 4 }}
              aria-label={`${labelFor(key)} legend icon`}
            >
              <line
                x1="0" y1="16" x2="32" y2="16"
                stroke={item.color}
                strokeWidth="4"
                strokeDasharray={item.payload?.strokeDasharray}
              />
            </svg>
            <span
              style={{
                color: item.color,
                fontSize: 11,
                fontWeight: 600,
                textDecoration: detail ? 'underline dotted 1px' : 'none',
                textUnderlineOffset: 3,
              }}
            >
              {labelFor(key)}
            </span>
            {isHovered && detail && (
              <div
                role="tooltip"
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 10,
                  width: 360,
                  maxWidth: '90vw',
                  zIndex: 50,
                  textAlign: 'left',
                  cursor: 'default',
                }}
              >
                <div
                  className="rounded-lg border-2 border-border-default bg-bg-primary p-4 text-[12px]"
                  style={{
                    boxShadow:
                      '0 10px 32px rgba(0,0,0,0.30), 0 0 0 1px rgba(255,255,255,0.04)',
                  }}
                >
                  <div className="flex items-center gap-2 pb-2 mb-2 border-b border-border-default/40">
                    <span
                      className="inline-block w-3 h-3 rounded-full shrink-0"
                      style={{ background: item.color }}
                    />
                    <strong className="text-txt-primary text-[14px] font-bold">
                      {detail.title}
                    </strong>
                  </div>
                  <div className="space-y-3 leading-relaxed">
                    <div>
                      <div className="text-[10px] text-txt-muted uppercase tracking-wider font-semibold mb-1">
                        무엇
                      </div>
                      <div className="text-[13px] text-txt-primary">
                        {detail.what}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-txt-muted uppercase tracking-wider font-semibold mb-1">
                        어떻게 만들어지나
                      </div>
                      <ul className="text-[12px] text-txt-secondary space-y-1 pl-3 list-disc marker:text-brand-purple">
                        {detail.how.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </div>
                    {detail.read && (
                      <div className="rounded bg-status-info/[0.08] border border-status-info/30 p-2.5 text-[12px] text-txt-secondary">
                        <strong className="text-status-info block mb-0.5">💡 해석</strong>
                        {detail.read}
                      </div>
                    )}
                  </div>
                  {/* Arrow pointing down to legend item */}
                  <div
                    style={{
                      position: 'absolute',
                      top: '100%',
                      left: '50%',
                      transform: 'translateX(-50%)',
                      width: 0,
                      height: 0,
                      borderLeft: '8px solid transparent',
                      borderRight: '8px solid transparent',
                      borderTop: '8px solid var(--border-default)',
                    }}
                  />
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
