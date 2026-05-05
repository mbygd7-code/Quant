'use client';

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { ClientOnly } from './client-only';

interface SubScoreItem {
  factor: string;
  score: number;
}

const FACTOR_COLOR = (v: number) => {
  if (v >= 0.65) return '#723CEB';
  if (v >= 0.5) return '#A0A0A0';
  if (v >= 0.35) return '#FFEF63';
  return '#EF4444';
};

export function SubscoreBar({ data }: { data: SubScoreItem[] }) {
  return (
    <div className="h-64 w-full">
     <ClientOnly>
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
          <XAxis type="number" domain={[0, 1]} tick={{ fill: 'var(--text-secondary)', fontSize: 11 }} />
          <YAxis
            type="category"
            dataKey="factor"
            tick={{ fill: 'var(--text-primary)', fontSize: 12 }}
            width={120}
          />
          <Tooltip
            cursor={{ fill: 'rgba(114,60,235,0.08)' }}
            contentStyle={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-default)',
              borderRadius: 8,
              fontSize: 12,
            }}
            formatter={(v) => (typeof v === 'number' ? v.toFixed(3) : String(v))}
          />
          <Bar dataKey="score" radius={[4, 4, 4, 4]}>
            {data.map((d, i) => (
              <Cell key={i} fill={FACTOR_COLOR(d.score)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
     </ClientOnly>
    </div>
  );
}
