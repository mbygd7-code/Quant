'use client';

import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

interface Candle {
  date: string;     // ISO-like for display
  close: number;
  volume?: number;
}

interface Props {
  ticker: string;
  variant: 'kr' | 'us';
  height?: number;
  /** for US, "AAPL"; for KR, 6-digit code */
  symbol?: string;
}

/**
 * Larger inline chart used by the row "expand" affordance. KR pulls from
 * /api/kr-chart (NAVER), US pulls from /api/us-chart (Yahoo Finance).
 */
export function StockChart({ ticker, variant, height = 180, symbol }: Props) {
  const [data, setData] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url =
      variant === 'kr'
        ? `/api/kr-chart?ticker=${encodeURIComponent(ticker)}&days=90`
        : `/api/us-chart?symbol=${encodeURIComponent(symbol ?? ticker)}&period=daily`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: Array<{ date?: string; t?: number; close: number; volume?: number }>; error?: string }) => {
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
          setData([]);
          return;
        }
        setData(
          (j.candles ?? []).map((c) => ({
            date: c.date ?? new Date(c.t ?? 0).toISOString().slice(0, 10),
            close: c.close,
            volume: c.volume,
          })),
        );
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, symbol, variant]);

  if (loading) {
    return (
      <div className="w-full rounded bg-bg-tertiary/40 animate-pulse" style={{ height }} />
    );
  }
  if (error) {
    return (
      <div className="text-xs text-status-danger px-2 py-3">차트 로드 실패: {error}</div>
    );
  }
  if (data.length === 0) {
    return <div className="text-xs text-txt-muted px-2 py-3">차트 데이터 없음</div>;
  }

  const closes = data.map((d) => d.close);
  const first = closes[0];
  const last = closes[closes.length - 1];
  const isUp = last >= first;
  // KR convention: red up, blue down. US: green up, red down.
  const color =
    variant === 'kr'
      ? isUp
        ? 'var(--status-danger)'
        : 'var(--status-info)'
      : isUp
        ? 'var(--status-success)'
        : 'var(--status-danger)';
  const change = ((last - first) / first) * 100;
  const fmt = (v: number) =>
    variant === 'kr'
      ? v.toLocaleString('ko-KR')
      : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-xs px-1">
        <span className="text-txt-muted">최근 {data.length}일</span>
        <span className="tabular-nums" style={{ color }}>
          {fmt(last)} ({change > 0 ? '+' : ''}{change.toFixed(2)}%)
        </span>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`grad-${ticker}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border-subtle)" strokeOpacity="0.4" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: 'var(--txt-muted)' }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={40}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fontSize: 10, fill: 'var(--txt-muted)' }}
            axisLine={false}
            tickLine={false}
            width={50}
            tickFormatter={(v) => fmt(Number(v))}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              fontSize: 11,
              borderRadius: 6,
            }}
            formatter={(v) => [fmt(Number(v)), '종가']}
            labelStyle={{ color: 'var(--txt-secondary)' }}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke={color}
            strokeWidth={1.6}
            fill={`url(#grad-${ticker})`}
            dot={false}
            activeDot={{ r: 3, fill: color, stroke: 'white', strokeWidth: 1 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
