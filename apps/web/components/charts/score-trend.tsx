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

interface Point {
  date: string;
  final_score: number;
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
): { mean: Point[]; lower: Point[]; upper: Point[] } {
  const empty = { mean: [] as Point[], lower: [] as Point[], upper: [] as Point[] };
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
    const clip = (v: number) => Math.max(0, Math.min(1, v));
    mean.push({ date, final_score: clip(projected) });
    lower.push({ date, final_score: clip(projected - halfWidth) });
    upper.push({ date, final_score: clip(projected + halfWidth) });
  }
  return { mean, lower, upper };
}

export function ScoreTrend({ data, showForecast = true }: { data: Point[]; showForecast?: boolean }) {
  const { mean, lower, upper } = showForecast
    ? buildForecast(data, 5)
    : { mean: [], lower: [], upper: [] };

  // Merge into one array per Recharts.
  // Last historical point gets predicted = its own value so the dashed
  // forecast line connects without a visual gap.
  const merged: ChartRow[] = [
    ...data.map((p, i) => ({
      date: p.date,
      actual: p.final_score,
      predicted: i === data.length - 1 && mean.length > 0 ? p.final_score : null,
      band_low: i === data.length - 1 && lower.length > 0 ? p.final_score : null,
      band_high: i === data.length - 1 && upper.length > 0 ? p.final_score : null,
    })),
    ...mean.map((p, i) => ({
      date: p.date,
      actual: null,
      predicted: p.final_score,
      band_low: lower[i]?.final_score ?? null,
      band_high: upper[i]?.final_score ?? null,
    })),
  ];

  return (
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
            contentStyle={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v, name) => {
              if (typeof v !== 'number') return [String(v), String(name)];
              const labels: Record<string, string> = {
                actual: '실측',
                predicted: '예측',
                band_low: '95% 하단',
                band_high: '95% 상단',
              };
              return [v.toFixed(3), labels[String(name)] ?? String(name)];
            }}
          />
          <ReferenceLine y={0.65} stroke="rgba(114,60,235,0.45)" strokeDasharray="4 4" />
          <ReferenceLine y={0.35} stroke="rgba(239,68,68,0.45)" strokeDasharray="4 4" />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            iconType="plainline"
            formatter={(value) => {
              if (value === 'actual') return '실측 점수';
              if (value === 'predicted') return '예측 추세';
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
          {showForecast && mean.length > 0 && (
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
  );
}
