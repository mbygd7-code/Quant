'use client';

import {
  Area,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

import { ClientOnly } from '@/components/charts/client-only';

interface Snap {
  date: string;
  total: number;
  ret: number;
}

const krw = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}원`;

/** Equity curve for the paper portfolio — area vs initial capital line. */
export function PaperEquityChart({
  snapshots,
  initialCapital,
}: {
  snapshots: Snap[];
  initialCapital: number;
}) {
  if (snapshots.length === 0) {
    return (
      <div className="flex h-44 items-center justify-center text-sm text-txt-muted">
        첫 매매 사이클 이후부터 자산 곡선이 기록됩니다.
      </div>
    );
  }
  const vals = snapshots.map((s) => s.total);
  const lo = Math.min(...vals, initialCapital);
  const hi = Math.max(...vals, initialCapital);
  const pad = (hi - lo) * 0.08 || hi * 0.01;

  return (
    <div className="h-56 w-full">
      <ClientOnly fallback={<div className="h-full w-full animate-pulse rounded bg-bg-secondary/30" />}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
          <ComposedChart data={snapshots} margin={{ top: 8, right: 12, bottom: 4, left: 8 }}>
            <defs>
              <linearGradient id="paperEquity" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#723CEB" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#723CEB" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="date"
              tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
              tickFormatter={(v: string) => v.slice(5)}
              minTickGap={28}
            />
            <YAxis
              domain={[lo - pad, hi + pad]}
              tick={{ fill: 'var(--text-secondary)', fontSize: 10 }}
              width={64}
              tickFormatter={(v: number) =>
                v >= 100_000_000 ? `${(v / 100_000_000).toFixed(2)}억` : `${Math.round(v / 10_000)}만`
              }
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                const row = payload[0]?.payload as Snap | undefined;
                if (!row) return null;
                return (
                  <div
                    style={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-default)',
                      borderRadius: 8,
                      fontSize: 12,
                      padding: '8px 10px',
                    }}
                  >
                    <div style={{ color: 'var(--text-secondary)', marginBottom: 2 }}>{label}</div>
                    <div>
                      총자산 <b>{krw(row.total)}</b>
                    </div>
                    <div style={{ color: row.ret >= 0 ? '#22A06B' : '#E5484D' }}>
                      누적 {row.ret >= 0 ? '+' : ''}
                      {row.ret.toFixed(2)}%
                    </div>
                  </div>
                );
              }}
            />
            <ReferenceLine
              y={initialCapital}
              stroke="rgba(255,255,255,0.25)"
              strokeDasharray="4 4"
              label={{
                value: '초기자본',
                position: 'insideTopRight',
                fill: 'var(--text-secondary)',
                fontSize: 10,
              }}
            />
            <Area
              type="monotone"
              dataKey="total"
              stroke="#723CEB"
              strokeWidth={2}
              fill="url(#paperEquity)"
              isAnimationActive={false}
              name="총자산"
            />
          </ComposedChart>
        </ResponsiveContainer>
      </ClientOnly>
    </div>
  );
}
