'use client';

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

interface Point {
  date: string;
  final_score: number;
}

interface MLPrediction {
  target_date: string;
  predicted_score: number;
  lower_95: number | null;
  upper_95: number | null;
}

interface ChartRow {
  date: string;
  actual: number | null;
  predicted: number | null;
  band_low: number | null;
  band_high: number | null;
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
  data,
  showForecast = true,
  mlPredictions,
}: {
  data: Point[];
  showForecast?: boolean;
  mlPredictions?: MLPrediction[];
}) {
  // Prefer ML-stored predictions if available; fall back to in-browser OLS.
  let mean: Point[] = [];
  let lower: Point[] = [];
  let upper: Point[] = [];
  let fittedPast: Point[] = [];
  let usingML = false;

  if (showForecast) {
    // Always compute the OLS fit — gives us the backcast/fitted line over
    // historical dates so the user can eyeball residuals vs the actual line.
    const ols = buildForecast(data, 5);
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

  // Build a date-keyed lookup for the fitted-past series so we can attach
  // a `predicted` value to every historical row (not just the last one).
  const fittedByDate = new Map(fittedPast.map((p) => [p.date, p.final_score]));

  // Merge into one array per Recharts.
  // - History rows: actual = real score, predicted = OLS-fitted value (if available).
  // - Forecast rows: actual = null, predicted = projection.
  // - `residual` and `residual_pct` are derived for tooltip readout.
  const merged: (ChartRow & { residual: number | null; residual_pct: number | null })[] = [
    ...data.map((p, i) => {
      const fitted = fittedByDate.get(p.date) ?? null;
      // Make the forecast line connect by setting predicted on the last
      // history point even if it's outside the OLS window.
      const predicted =
        fitted !== null
          ? fitted
          : i === data.length - 1 && mean.length > 0
            ? p.final_score
            : null;
      const residual = predicted !== null ? p.final_score - predicted : null;
      const residual_pct =
        predicted !== null && predicted !== 0
          ? ((p.final_score - predicted) / predicted) * 100
          : null;
      return {
        date: p.date,
        actual: p.final_score,
        predicted,
        band_low: i === data.length - 1 && lower.length > 0 ? p.final_score : null,
        band_high: i === data.length - 1 && upper.length > 0 ? p.final_score : null,
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

  return (
    <div className="w-full">
     {mae !== null && mape !== null && (
       <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[color:var(--text-secondary)]">
         <span className="text-txt-muted">
           실측 vs 예측 (최근 {overlap.length}일):
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
                </div>
              );
            }}
          />
          <ReferenceLine y={0.65} stroke="rgba(114,60,235,0.45)" strokeDasharray="4 4" />
          <ReferenceLine y={0.35} stroke="rgba(239,68,68,0.45)" strokeDasharray="4 4" />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            iconType="plainline"
            formatter={(value) => {
              if (value === 'actual') return '실측 점수';
              if (value === 'predicted') return usingML ? '예측 (GBM ML)' : '예측 (OLS)';
              if (value === 'band_high') return '95% 신뢰구간';
              return String(value);
            }}
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
        </ComposedChart>
      </ResponsiveContainer>
     </ClientOnly>
     </div>
    </div>
  );
}
