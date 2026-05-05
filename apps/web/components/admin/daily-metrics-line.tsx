'use client';

import {
  CartesianGrid,
  LineChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ClientOnly } from '@/components/charts/client-only';

export function DailyMetricsLine({
  data,
  target,
}: {
  data: { date: string; value: number }[];
  target: number;
}) {
  return (
    <div className="h-48 w-full">
     <ClientOnly>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis
            dataKey="date"
            tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
            tickFormatter={(v) => v.slice(5)}
          />
          <YAxis tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} domain={[0, Math.max(target * 1.1, 50)]} />
          <Tooltip
            contentStyle={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <ReferenceLine y={target} stroke="rgba(114,60,235,0.4)" strokeDasharray="4 4" />
          <Line type="monotone" dataKey="value" stroke="#723CEB" strokeWidth={2} dot={{ r: 2.5, fill: '#723CEB' }} />
        </LineChart>
      </ResponsiveContainer>
     </ClientOnly>
    </div>
  );
}
