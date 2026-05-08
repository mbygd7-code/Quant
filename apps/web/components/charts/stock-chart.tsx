'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';

export type ChartPeriod = '1d' | '1w' | '1m' | '3m' | '1y';
export type ChartMode = 'line' | 'candle';

interface RawCandle {
  date?: string;
  t?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface ChartRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma20?: number | null;
  ma60?: number | null;
  // for candle rendering — recharts Bar wants [low, high]/[open, close]
  wick: [number, number];
  body: [number, number];
  isUp: boolean;
}

interface Props {
  ticker: string;
  variant: 'kr' | 'us';
  height?: number;
  /** for US: pass the symbol; for KR pass the 6-digit ticker again. */
  symbol?: string;
  /** initial period — defaults to 3m */
  initialPeriod?: ChartPeriod;
  /** initial mode — defaults to line */
  initialMode?: ChartMode;
}

const PERIODS: { id: ChartPeriod; label: string }[] = [
  { id: '1d', label: '1D' },
  { id: '1w', label: '1W' },
  { id: '1m', label: '1M' },
  { id: '3m', label: '3M' },
  { id: '1y', label: '1Y' },
];

function sma(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < window) return out;
  let sum = 0;
  for (let i = 0; i < window; i++) sum += values[i];
  out[window - 1] = sum / window;
  for (let i = window; i < values.length; i++) {
    sum += values[i] - values[i - window];
    out[i] = sum / window;
  }
  return out;
}

export function StockChart({
  ticker,
  variant,
  height = 280,
  symbol,
  initialPeriod = '3m',
  initialMode = 'line',
}: Props) {
  const [period, setPeriod] = useState<ChartPeriod>(initialPeriod);
  const [mode, setMode] = useState<ChartMode>(initialMode);
  const [showMA, setShowMA] = useState(true);
  const [showVolume, setShowVolume] = useState(true);

  const [raw, setRaw] = useState<RawCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url =
      variant === 'kr'
        ? `/api/kr-chart?ticker=${encodeURIComponent(ticker)}&period=${period}`
        : `/api/us-chart?symbol=${encodeURIComponent(symbol ?? ticker)}&period=${period}`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: RawCandle[]; error?: string }) => {
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
          setRaw([]);
          return;
        }
        setRaw(j.candles ?? []);
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
  }, [ticker, symbol, variant, period]);

  const data: ChartRow[] = useMemo(() => {
    if (raw.length === 0) return [];
    const closes = raw.map((c) => c.close);
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, 60);
    return raw.map((c, i) => {
      const date =
        c.date ?? (c.t ? new Date(c.t).toISOString().slice(0, period === '1d' ? 16 : 10) : '');
      const isUp = c.close >= c.open;
      return {
        date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
        ma20: ma20[i],
        ma60: ma60[i],
        wick: [c.low, c.high] as [number, number],
        body: isUp ? ([c.open, c.close] as [number, number]) : ([c.close, c.open] as [number, number]),
        isUp,
      };
    });
  }, [raw, period]);

  const first = data[0]?.close ?? null;
  const last = data[data.length - 1]?.close ?? null;
  const isUp = first != null && last != null ? last >= first : null;
  const change = first != null && last != null ? ((last - first) / first) * 100 : null;

  // KR convention: red=up, blue=down. US: green=up, red=down.
  const upColor = variant === 'kr' ? 'var(--status-danger)' : 'var(--status-success)';
  const downColor = variant === 'kr' ? 'var(--status-info)' : 'var(--status-danger)';
  const lineColor = isUp === false ? downColor : upColor;
  const fmt = (v: number) =>
    variant === 'kr'
      ? v.toLocaleString('ko-KR')
      : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

  return (
    <div className="space-y-2">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border-subtle overflow-hidden">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-medium transition-colors',
                period === p.id
                  ? 'bg-brand-purple/15 text-brand-purple'
                  : 'text-txt-secondary hover:bg-bg-tertiary/40',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-md border border-border-subtle overflow-hidden">
          {(['line', 'candle'] as ChartMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-medium transition-colors',
                mode === m
                  ? 'bg-brand-purple/15 text-brand-purple'
                  : 'text-txt-secondary hover:bg-bg-tertiary/40',
              )}
            >
              {m === 'line' ? '라인' : '캔들'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowMA((v) => !v)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium rounded-md border border-border-subtle transition-colors',
            showMA ? 'bg-brand-purple/15 text-brand-purple' : 'text-txt-secondary hover:bg-bg-tertiary/40',
          )}
          title="20일/60일 이동평균선"
        >
          MA 20/60
        </button>
        <button
          type="button"
          onClick={() => setShowVolume((v) => !v)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-medium rounded-md border border-border-subtle transition-colors',
            showVolume ? 'bg-brand-purple/15 text-brand-purple' : 'text-txt-secondary hover:bg-bg-tertiary/40',
          )}
        >
          거래량
        </button>
        <span className="ml-auto text-xs tabular-nums" style={{ color: lineColor }}>
          {last != null ? fmt(last) : '—'}
          {change != null ? ` (${change > 0 ? '+' : ''}${change.toFixed(2)}%)` : ''}
        </span>
      </div>

      {/* Chart */}
      {loading ? (
        <div className="w-full rounded bg-bg-tertiary/40 animate-pulse" style={{ height }} />
      ) : error ? (
        <div className="text-xs text-status-danger px-2 py-3">차트 로드 실패: {error}</div>
      ) : data.length === 0 ? (
        <div className="text-xs text-txt-muted px-2 py-3">차트 데이터 없음</div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <ComposedChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
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
              yAxisId="price"
              domain={['auto', 'auto']}
              tick={{ fontSize: 10, fill: 'var(--txt-muted)' }}
              axisLine={false}
              tickLine={false}
              width={56}
              tickFormatter={(v) => fmt(Number(v))}
            />
            {showVolume && (
              <YAxis
                yAxisId="volume"
                orientation="right"
                domain={[0, (max: number) => max * 4]}
                hide
              />
            )}
            <Tooltip
              content={(p: unknown) => <ChartTooltip raw={p} variant={variant} />}
            />

            {/* Candle wicks (high-low lines) */}
            {mode === 'candle' && (
              <>
                <Bar
                  yAxisId="price"
                  dataKey="wick"
                  shape={(props: unknown) => <WickShape {...(props as WickShapeProps)} upColor={upColor} downColor={downColor} />}
                  isAnimationActive={false}
                />
                <Bar
                  yAxisId="price"
                  dataKey="body"
                  shape={(props: unknown) => <BodyShape {...(props as BodyShapeProps)} upColor={upColor} downColor={downColor} />}
                  isAnimationActive={false}
                />
              </>
            )}

            {/* Line mode */}
            {mode === 'line' && (
              <Line
                yAxisId="price"
                type="monotone"
                dataKey="close"
                stroke={lineColor}
                strokeWidth={1.6}
                dot={false}
                activeDot={{ r: 3, fill: lineColor, stroke: 'white', strokeWidth: 1 }}
                isAnimationActive={false}
              />
            )}

            {/* Moving averages */}
            {showMA && (
              <>
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="ma20"
                  stroke="#f59e0b"
                  strokeWidth={1}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="ma60"
                  stroke="#a855f7"
                  strokeWidth={1}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              </>
            )}

            {/* Volume bars (bottom) */}
            {showVolume && (
              <Bar
                yAxisId="volume"
                dataKey="volume"
                shape={(props: unknown) => (
                  <VolumeShape {...(props as VolumeShapeProps)} upColor={upColor} downColor={downColor} />
                )}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {showMA && data.length > 0 && (
        <div className="flex items-center gap-3 text-[10px] text-txt-muted px-1">
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5" style={{ background: '#f59e0b' }} />
            MA 20
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-3 h-0.5" style={{ background: '#a855f7' }} />
            MA 60
          </span>
        </div>
      )}
    </div>
  );
}

interface WickShapeProps {
  x?: number;
  width?: number;
  payload?: ChartRow;
  y?: number;
  height?: number;
  upColor: string;
  downColor: string;
}
function WickShape(p: WickShapeProps) {
  if (p.x == null || p.width == null || p.y == null || p.height == null || !p.payload) return null;
  const cx = p.x + p.width / 2;
  const color = p.payload.isUp ? p.upColor : p.downColor;
  return <line x1={cx} x2={cx} y1={p.y} y2={p.y + p.height} stroke={color} strokeWidth={1} />;
}

interface BodyShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartRow;
  upColor: string;
  downColor: string;
}
function BodyShape(p: BodyShapeProps) {
  if (p.x == null || p.y == null || p.width == null || p.height == null || !p.payload) return null;
  const w = Math.max(2, p.width * 0.7);
  const offset = (p.width - w) / 2;
  const color = p.payload.isUp ? p.upColor : p.downColor;
  return (
    <rect
      x={p.x + offset}
      y={p.y}
      width={w}
      height={Math.max(1, p.height)}
      fill={color}
      stroke={color}
    />
  );
}

interface VolumeShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartRow;
  upColor: string;
  downColor: string;
}
function VolumeShape(p: VolumeShapeProps) {
  if (p.x == null || p.y == null || p.width == null || p.height == null || !p.payload) return null;
  const w = Math.max(1, p.width * 0.7);
  const offset = (p.width - w) / 2;
  const color = p.payload.isUp ? p.upColor : p.downColor;
  return (
    <rect
      x={p.x + offset}
      y={p.y}
      width={w}
      height={p.height}
      fill={color}
      fillOpacity={0.35}
    />
  );
}

function ChartTooltip({ raw, variant }: { raw: unknown; variant: 'kr' | 'us' }) {
  const r = raw as { active?: boolean; payload?: Array<{ payload?: ChartRow }> } | null;
  if (!r?.active || !r.payload || r.payload.length === 0) return null;
  const row = r.payload[0]?.payload;
  if (!row) return null;
  const fmt = (v: number) =>
    variant === 'kr'
      ? v.toLocaleString('ko-KR')
      : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  return (
    <div className="rounded-md border border-border-subtle bg-bg-secondary p-2 text-[11px] shadow-md">
      <div className="text-txt-secondary mb-1">{row.date}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
        <span className="text-txt-muted">시</span>
        <span className="text-right">{fmt(row.open)}</span>
        <span className="text-txt-muted">고</span>
        <span className="text-right">{fmt(row.high)}</span>
        <span className="text-txt-muted">저</span>
        <span className="text-right">{fmt(row.low)}</span>
        <span className="text-txt-muted">종</span>
        <span className="text-right" style={{ color: row.isUp ? (variant === 'kr' ? 'var(--status-danger)' : 'var(--status-success)') : (variant === 'kr' ? 'var(--status-info)' : 'var(--status-danger)') }}>
          {fmt(row.close)}
        </span>
        {row.volume > 0 && (
          <>
            <span className="text-txt-muted">거래량</span>
            <span className="text-right">{row.volume.toLocaleString('en-US')}</span>
          </>
        )}
        {row.ma20 != null && (
          <>
            <span className="text-txt-muted">MA20</span>
            <span className="text-right" style={{ color: '#f59e0b' }}>
              {fmt(row.ma20)}
            </span>
          </>
        )}
        {row.ma60 != null && (
          <>
            <span className="text-txt-muted">MA60</span>
            <span className="text-right" style={{ color: '#a855f7' }}>
              {fmt(row.ma60)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
