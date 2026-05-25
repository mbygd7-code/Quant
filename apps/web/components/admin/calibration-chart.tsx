'use client';

import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';

import { ClientOnly } from '@/components/charts/client-only';

interface CalibrationPoint {
  decile_label: string;
  avg_confidence: number;
  actual_hit_rate_5d: number;
  n_signals: number;
}

/**
 * Plots stated confidence (x) vs realized 5-day hit rate (y) for
 * STRONG_BUY/BUY signals.  The dashed reference line y=x represents
 * perfect calibration.  Points above the line = under-confident model;
 * points below = over-confident model.
 */
export function CalibrationChart({ data }: { data: CalibrationPoint[] }) {
  return (
    <div className="h-64 w-full">
      <ClientOnly>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <ScatterChart margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              type="number"
              dataKey="avg_confidence"
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
              label={{
                value: '신뢰도 (confidence)',
                position: 'insideBottom',
                offset: -2,
                fill: 'var(--text-muted)',
                fontSize: 10,
              }}
            />
            <YAxis
              type="number"
              dataKey="actual_hit_rate_5d"
              domain={[0, 1]}
              tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
              tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
              label={{
                value: '실제 5일 hit rate',
                angle: -90,
                position: 'insideLeft',
                offset: 12,
                fill: 'var(--text-muted)',
                fontSize: 10,
              }}
            />
            <ZAxis type="number" dataKey="n_signals" range={[40, 220]} name="신호 수" />
            <Tooltip
              contentStyle={{
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-default)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(value: number | string, name: string) => {
                if (name === 'avg_confidence' || name === 'actual_hit_rate_5d') {
                  return [`${(Number(value) * 100).toFixed(1)}%`, name];
                }
                return [value, name];
              }}
            />
            <ReferenceLine
              segment={[
                { x: 0, y: 0 },
                { x: 1, y: 1 },
              ]}
              stroke="rgba(114,60,235,0.4)"
              strokeDasharray="4 4"
              label={{
                value: '완벽한 calibration (y=x)',
                position: 'insideTopRight',
                fill: 'rgba(114,60,235,0.6)',
                fontSize: 10,
              }}
            />
            <Scatter data={data} fill="#22c55e" />
          </ScatterChart>
        </ResponsiveContainer>
      </ClientOnly>
    </div>
  );
}
