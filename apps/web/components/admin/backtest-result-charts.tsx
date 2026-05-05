'use client';

import {
  BarChart,
  Bar,
  Cell,
  CartesianGrid,
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ClientOnly } from '@/components/charts/client-only';

interface Props {
  equityCurve: { date: string; cum: number }[];
  signalWinRate: { signal: string; winRate: number; n: number }[];
}

export function BacktestResultCharts({ equityCurve, signalWinRate }: Props) {
  return (
    <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-heading">누적 수익률 추이</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full">
           <ClientOnly>
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <LineChart data={equityCurve} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="date"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
                  tickFormatter={(v) => v.slice(5)}
                />
                <YAxis
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v) => (typeof v === 'number' ? `${(v * 100).toFixed(2)}%` : String(v))}
                />
                <Line type="monotone" dataKey="cum" stroke="#723CEB" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
           </ClientOnly>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-heading">신호별 승률</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-64 w-full">
           <ClientOnly>
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <BarChart data={signalWinRate} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  type="number"
                  domain={[0, 1]}
                  tick={{ fill: 'var(--text-secondary)', fontSize: 11 }}
                  tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                />
                <YAxis type="category" dataKey="signal" tick={{ fill: 'var(--text-primary)', fontSize: 11 }} width={70} />
                <Tooltip
                  cursor={{ fill: 'rgba(114,60,235,0.08)' }}
                  contentStyle={{
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(v, _, item) => {
                    const num = typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : String(v);
                    const n = item?.payload?.n;
                    return [`${num} (n=${n})`, '승률'];
                  }}
                />
                <Bar dataKey="winRate" radius={[4, 4, 4, 4]}>
                  {signalWinRate.map((d, i) => (
                    <Cell key={i} fill={d.winRate >= 0.5 ? '#34D399' : '#EF4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
           </ClientOnly>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
