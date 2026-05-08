'use client';

import { useEffect, useState } from 'react';

export interface SparkPoint {
  t?: number | string;
  close: number;
}

/**
 * Pure-SVG sparkline — no Recharts/ResponsiveContainer overhead, ideal
 * for inline use inside list rows where dozens render at once. Color
 * follows last-vs-first direction (한국 컨벤션: 빨강 ↑, 파랑 ↓).
 */
export function Sparkline({
  data,
  width = 80,
  height = 24,
  loading = false,
  convention = 'kr',
}: {
  data: SparkPoint[];
  width?: number;
  height?: number;
  loading?: boolean;
  convention?: 'kr' | 'us';
}) {
  if (loading) {
    return (
      <div
        className="rounded bg-bg-tertiary/40 animate-pulse"
        style={{ width, height }}
      />
    );
  }
  if (!data || data.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden="true">
        <line x1="0" y1={height / 2} x2={width} y2={height / 2} stroke="var(--txt-muted)" strokeOpacity="0.3" strokeDasharray="3 3" />
      </svg>
    );
  }

  const closes = data.map((d) => d.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const stepX = data.length > 1 ? width / (data.length - 1) : width;

  const first = closes[0];
  const last = closes[closes.length - 1];
  const isUp = last >= first;
  // KR: 상승=danger(red), 하락=info(blue). US: 상승=success(green), 하락=danger(red).
  const stroke = convention === 'kr'
    ? (isUp ? 'var(--status-danger)' : 'var(--status-info)')
    : (isUp ? 'var(--status-success)' : 'var(--status-danger)');

  const pts = closes.map((c, i) => {
    const x = i * stepX;
    const y = height - ((c - min) / range) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = 'M ' + pts.join(' L ');
  const fillPath = `${path} L ${width},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} aria-hidden="true">
      <path d={fillPath} fill={stroke} fillOpacity="0.08" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" />
      <circle
        cx={(data.length - 1) * stepX}
        cy={height - ((last - min) / range) * (height - 2) - 1}
        r="1.6"
        fill={stroke}
      />
    </svg>
  );
}

interface UseChartResult {
  candles: SparkPoint[];
  loading: boolean;
  error: string | null;
}

/**
 * Lazy-load daily candles for a KR ticker. Only fires when `enabled`
 * flips true so off-screen rows don't fetch.
 */
export function useKrSparkline(ticker: string, enabled = true, days = 30): UseChartResult {
  const [candles, setCandles] = useState<SparkPoint[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !/^\d{6}$/.test(ticker)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/kr-chart?ticker=${ticker}&days=${days}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: Array<{ date: string; close: number }> }) => {
        if (cancelled) return;
        setCandles((j.candles ?? []).map((c) => ({ t: c.date, close: c.close })));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker, enabled, days]);

  return { candles, loading, error };
}

export function useUsSparkline(symbol: string, enabled = true): UseChartResult {
  const [candles, setCandles] = useState<SparkPoint[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !symbol) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/us-chart?symbol=${encodeURIComponent(symbol)}&period=daily`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: Array<{ t: number; close: number }> }) => {
        if (cancelled) return;
        setCandles((j.candles ?? []).map((c) => ({ t: c.t, close: c.close })));
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'fetch failed');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, enabled]);

  return { candles, loading, error };
}
