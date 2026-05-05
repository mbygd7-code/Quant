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
} from 'recharts';
import { ClientOnly } from './client-only';

interface Point {
  date: string;
  final_score: number;
}

export function ScoreTrend({ data }: { data: Point[] }) {
  return (
    <div className="h-56 w-full">
     <ClientOnly>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
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
            formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : String(v))}
          />
          <ReferenceLine y={0.65} stroke="rgba(114,60,235,0.45)" strokeDasharray="4 4" />
          <ReferenceLine y={0.35} stroke="rgba(239,68,68,0.45)" strokeDasharray="4 4" />
          <Line
            type="monotone"
            dataKey="final_score"
            stroke="#723CEB"
            strokeWidth={2}
            dot={{ r: 2.5, fill: '#723CEB' }}
            activeDot={{ r: 4 }}
          />
        </LineChart>
      </ResponsiveContainer>
     </ClientOnly>
    </div>
  );
}
