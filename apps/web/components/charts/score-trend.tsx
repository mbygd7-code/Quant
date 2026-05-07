'use client';

import {
  LineChart,
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
}

/**
 * Build a 5-day forecast using OLS slope on the last 7 history points
 * with mean-reversion dampening. The slope decays toward 0.5 (NEUTRAL)
 * so the forecast can't run away — typical analyst-style "trend
 * persists short-term, fades mid-term" assumption.
 */
function buildForecast(history: Point[], horizonDays = 5): Point[] {
  if (history.length < 3) return [];
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

  const last = history[history.length - 1];
  const lastDate = new Date(last.date);
  const out: Point[] = [];
  let cursor = new Date(lastDate);
  let added = 0;
  while (added < horizonDays) {
    cursor = new Date(cursor.getTime() + 86400_000);
    const dow = cursor.getDay();
    if (dow === 0 || dow === 6) continue;            // skip weekends
    added += 1;
    const x = n - 1 + added;
    const damp = Math.pow(0.75, added);                // 0.75, 0.56, 0.42, 0.32, 0.24
    const trend = intercept + slope * x;
    const projected = trend * damp + 0.5 * (1 - damp); // pull toward 0.5
    out.push({
      date: cursor.toISOString().slice(0, 10),
      final_score: Math.max(0, Math.min(1, projected)),
    });
  }
  return out;
}

export function ScoreTrend({ data, showForecast = true }: { data: Point[]; showForecast?: boolean }) {
  const forecast = showForecast ? buildForecast(data, 5) : [];

  // Build merged series: historical points have actual, forecast points have predicted.
  // The last historical point also carries a `predicted` value so the forecast line
  // visually attaches to the end of the actual line (no gap).
  const merged: ChartRow[] = [
    ...data.map((p, i) => ({
      date: p.date,
      actual: p.final_score,
      predicted: i === data.length - 1 && forecast.length > 0 ? p.final_score : null,
    })),
    ...forecast.map((p) => ({
      date: p.date,
      actual: null,
      predicted: p.final_score,
    })),
  ];

  return (
    <div className="h-56 w-full">
     <ClientOnly>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <LineChart data={merged} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
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
              const label = name === 'actual' ? '실측' : '예측';
              return [typeof v === 'number' ? v.toFixed(3) : String(v), label];
            }}
          />
          <ReferenceLine y={0.65} stroke="rgba(114,60,235,0.45)" strokeDasharray="4 4" />
          <ReferenceLine y={0.35} stroke="rgba(239,68,68,0.45)" strokeDasharray="4 4" />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            iconType="plainline"
            formatter={(value) => (value === 'actual' ? '실측 점수' : '예측 추세 (OLS · 5영업일)')}
          />
          <Line
            type="monotone"
            dataKey="actual"
            stroke="#723CEB"
            strokeWidth={2}
            dot={{ r: 2.5, fill: '#723CEB' }}
            activeDot={{ r: 4 }}
            connectNulls={false}
            name="actual"
          />
          {showForecast && forecast.length > 0 && (
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
            />
          )}
        </LineChart>
      </ResponsiveContainer>
     </ClientOnly>
    </div>
  );
}
