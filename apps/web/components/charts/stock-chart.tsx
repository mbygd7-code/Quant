'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Label,
  Line,
  ReferenceLine,
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
  wick: [number, number];
  body: [number, number];
  isUp: boolean;
}

interface Props {
  ticker: string;
  variant: 'kr' | 'us';
  height?: number;
  symbol?: string;
  initialPeriod?: ChartPeriod;
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
  // Professional default: candles carry more info than a line. The legacy
  // `line` mode is still available via the toggle for at-a-glance views
  // (e.g. inside narrow Sparkline-adjacent contexts).
  initialMode = 'candle',
}: Props) {
  const [period, setPeriod] = useState<ChartPeriod>(initialPeriod);
  const [mode, setMode] = useState<ChartMode>(initialMode);
  const [showMA, setShowMA] = useState(true);
  const [showVolume, setShowVolume] = useState(true);
  const [showRange, setShowRange] = useState(true);

  const [raw, setRaw] = useState<RawCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Server reports which trading day the 1D intraday data came from
  // (today when markets are open, the previous trading day otherwise).
  // Lets the UI label the chart honestly e.g. '5/15 분봉 (전 거래일)'.
  const [intradayDate, setIntradayDate] = useState<string | null>(null);

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
      .then((j: { candles?: RawCandle[]; error?: string; intraday_date?: string | null }) => {
        if (cancelled) return;
        if (j.error) {
          setError(j.error);
          setRaw([]);
          setIntradayDate(null);
          return;
        }
        setRaw(j.candles ?? []);
        setIntradayDate(j.intraday_date ?? null);
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
    // Filter out malformed rows BEFORE computing MA — otherwise NaN/
    // undefined OHLC propagate into the moving averages and the candle
    // shape arithmetic crashes. 1D intraday feeds occasionally include
    // gap rows with missing fields.
    const valid = raw.filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close),
    );
    if (valid.length === 0) return [];
    const closes = valid.map((c) => c.close);
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, 60);
    return valid.map((c, i) => {
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

  const last = data[data.length - 1] ?? null;
  const first = data[0]?.close ?? null;
  const isPeriodUp = first != null && last != null ? last.close >= first : null;
  const change = first != null && last != null ? last.close - first : null;
  const changePct = first != null && last != null ? ((last.close - first) / first) * 100 : null;

  // Range markers — the chart's own "high water marks" (period extremes,
  // not 52-week). Cheap to compute and consistent with what the trader sees.
  const periodHigh = useMemo(
    () => (data.length === 0 ? null : Math.max(...data.map((d) => d.high))),
    [data],
  );
  const periodLow = useMemo(
    () => (data.length === 0 ? null : Math.min(...data.map((d) => d.low))),
    [data],
  );

  // Palette — KR convention: red=up, blue=down. US: green up, red down.
  const upColor = variant === 'kr' ? '#F26D6D' : '#3DD68C';
  const downColor = variant === 'kr' ? '#5BA8F2' : '#F26D6D';
  const lineColor = isPeriodUp === false ? downColor : upColor;
  // Defensive formatters — 1D intraday data sometimes arrives with
  // undefined OHLC fields (gap candles, circuit breakers, etc.). The
  // chart shouldn't crash; show '—' for missing values.
  const fmt = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return '—';
    return variant === 'kr'
      ? v.toLocaleString('ko-KR')
      : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  };
  const fmtVol = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return '—';
    if (v >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
    if (v >= 1e4) return `${(v / 1e4).toFixed(1)}만`;
    return v.toLocaleString();
  };

  return (
    <div className="space-y-2">
      {/* ── Pro stats bar — TradingView-style header ────────────────── */}
      {!loading && !error && last && (
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-2 py-2 rounded-md bg-bg-secondary/40 border border-border-subtle/40">
          {/* Price + change */}
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-lg font-bold tabular-nums" style={{ color: lineColor }}>
              {fmt(last.close)}
            </span>
            {change != null && changePct != null && (
              <span
                className="text-[12px] font-mono tabular-nums font-semibold"
                style={{ color: lineColor }}
              >
                {change >= 0 ? '+' : ''}
                {fmt(change)} ({changePct >= 0 ? '+' : ''}
                {changePct.toFixed(2)}%)
              </span>
            )}
          </div>

          {/* OHLC compact */}
          <div className="flex items-baseline gap-3 text-[11px] tabular-nums">
            <span className="text-txt-muted">
              O <span className="text-txt-primary font-mono">{fmt(last.open)}</span>
            </span>
            <span className="text-txt-muted">
              H <span className="text-txt-primary font-mono">{fmt(last.high)}</span>
            </span>
            <span className="text-txt-muted">
              L <span className="text-txt-primary font-mono">{fmt(last.low)}</span>
            </span>
            <span className="text-txt-muted">
              V <span className="text-txt-primary font-mono">{fmtVol(last.volume)}</span>
            </span>
          </div>

          {/* MA values */}
          {showMA && (last.ma20 != null || last.ma60 != null) && (
            <div className="flex items-baseline gap-3 text-[11px] tabular-nums">
              {last.ma20 != null && (
                <span className="text-txt-muted">
                  MA20{' '}
                  <span className="font-mono" style={{ color: '#F59E0B' }}>
                    {fmt(last.ma20)}
                  </span>
                  <span
                    className="ml-0.5"
                    style={{
                      color: last.close >= last.ma20 ? upColor : downColor,
                    }}
                  >
                    {last.close >= last.ma20 ? '↑' : '↓'}
                  </span>
                </span>
              )}
              {last.ma60 != null && (
                <span className="text-txt-muted">
                  MA60{' '}
                  <span className="font-mono" style={{ color: '#A855F7' }}>
                    {fmt(last.ma60)}
                  </span>
                  <span
                    className="ml-0.5"
                    style={{
                      color: last.close >= last.ma60 ? upColor : downColor,
                    }}
                  >
                    {last.close >= last.ma60 ? '↑' : '↓'}
                  </span>
                </span>
              )}
            </div>
          )}

          {/* Period high/low */}
          {periodHigh != null && periodLow != null && (
            <div className="flex items-baseline gap-3 text-[11px] tabular-nums ml-auto">
              <span className="text-txt-muted">
                기간 H{' '}
                <span className="font-mono text-status-success">{fmt(periodHigh)}</span>
              </span>
              <span className="text-txt-muted">
                L <span className="font-mono text-status-danger">{fmt(periodLow)}</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Intraday fallback notice — when 1D loaded data from a previous
          trading day (weekend / pre-market), label it honestly. */}
      {period === '1d' && intradayDate && (() => {
        const today = new Date().toISOString().slice(0, 10);
        if (intradayDate === today) return null;
        const d = intradayDate.slice(5).replace('-', '/');
        return (
          <div className="flex items-center gap-1.5 text-[10px] text-status-warning bg-status-warning/10 border border-status-warning/30 rounded-md px-2.5 py-1.5">
            <span>ⓘ</span>
            <span>
              오늘 분봉 데이터가 없어 가장 최근 거래일{' '}
              <strong className="font-mono">{d}</strong>의 5분봉을 표시합니다.
            </span>
          </div>
        );
      })()}

      {/* ── Toolbar — period + mode + indicators ────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Period segmented control */}
        <div className="flex rounded-md bg-bg-secondary/40 p-0.5 border border-border-subtle/40">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriod(p.id)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-semibold transition-all rounded',
                period === p.id
                  ? 'bg-brand-purple text-white shadow-sm'
                  : 'text-txt-secondary hover:text-txt-primary',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Mode segmented */}
        <div className="flex rounded-md bg-bg-secondary/40 p-0.5 border border-border-subtle/40">
          {(['candle', 'line'] as ChartMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'px-2.5 py-1 text-[11px] font-semibold transition-all rounded',
                mode === m
                  ? 'bg-brand-purple text-white shadow-sm'
                  : 'text-txt-secondary hover:text-txt-primary',
              )}
            >
              {m === 'candle' ? '캔들' : '라인'}
            </button>
          ))}
        </div>

        {/* Indicator toggles */}
        <button
          type="button"
          onClick={() => setShowMA((v) => !v)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
            showMA
              ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
              : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
          )}
          title="20일/60일 이동평균선"
        >
          MA
        </button>
        <button
          type="button"
          onClick={() => setShowVolume((v) => !v)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
            showVolume
              ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
              : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
          )}
        >
          Vol
        </button>
        <button
          type="button"
          onClick={() => setShowRange((v) => !v)}
          className={cn(
            'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
            showRange
              ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
              : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
          )}
          title="기간 최고/최저 가격선"
        >
          H/L
        </button>
      </div>

      {/* ── Chart panes (price + volume share x-axis via syncId) ──── */}
      {loading ? (
        <div className="w-full rounded bg-bg-tertiary/40 animate-pulse" style={{ height }} />
      ) : error ? (
        <div className="text-xs text-status-danger px-2 py-3">차트 로드 실패: {error}</div>
      ) : data.length === 0 ? (
        <div className="rounded-md border border-border-subtle/40 bg-bg-secondary/30 px-4 py-6 text-center">
          <div className="text-sm text-txt-secondary mb-1">차트 데이터 없음</div>
          <div className="text-xs text-txt-muted">
            {period === '1d'
              ? '최근 5거래일 분봉 데이터가 없습니다. 1W 이상 다른 기간을 선택해 보세요.'
              : '해당 기간의 데이터를 불러올 수 없습니다.'}
          </div>
        </div>
      ) : (
        <div className="space-y-0">
          {/* Price pane */}
          <ResponsiveContainer width="100%" height={Math.round(height * (showVolume ? 0.78 : 1))}>
            <ComposedChart
              data={data}
              syncId="stock-chart"
              margin={{ top: 8, right: 56, bottom: showVolume ? 0 : 8, left: 0 }}
            >
              <CartesianGrid
                stroke="var(--border-subtle)"
                strokeOpacity="0.5"
                strokeDasharray="2 4"
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: 'var(--txt-muted)' }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={40}
                hide={showVolume}
              />
              <YAxis
                yAxisId="price"
                domain={['auto', 'auto']}
                tick={{ fontSize: 10, fill: 'var(--txt-muted)' }}
                axisLine={false}
                tickLine={false}
                width={56}
                orientation="right"
                tickFormatter={(v) => fmt(Number(v))}
              />
              <Tooltip
                cursor={{ stroke: 'var(--border-default)', strokeOpacity: 0.6, strokeDasharray: '3 3' }}
                content={(p: unknown) => <ChartTooltip raw={p} variant={variant} />}
              />

              {/* Candle */}
              {mode === 'candle' && (
                <Bar
                  yAxisId="price"
                  dataKey="wick"
                  shape={(props: unknown) => (
                    <CandleShape {...(props as CandleShapeProps)} upColor={upColor} downColor={downColor} />
                  )}
                  isAnimationActive={false}
                />
              )}

              {/* Line */}
              {mode === 'line' && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="close"
                  stroke={lineColor}
                  strokeWidth={1.8}
                  dot={false}
                  activeDot={{ r: 4, fill: lineColor, stroke: 'white', strokeWidth: 1.5 }}
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
                    stroke="#F59E0B"
                    strokeWidth={1.2}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  >
                    {/* Right-edge label — TradingView convention */}
                    {last?.ma20 != null && (
                      <Label
                        value="MA20"
                        position="right"
                        fill="#F59E0B"
                        fontSize={9}
                        fontWeight={600}
                      />
                    )}
                  </Line>
                  <Line
                    yAxisId="price"
                    type="monotone"
                    dataKey="ma60"
                    stroke="#A855F7"
                    strokeWidth={1.2}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  >
                    {last?.ma60 != null && (
                      <Label
                        value="MA60"
                        position="right"
                        fill="#A855F7"
                        fontSize={9}
                        fontWeight={600}
                      />
                    )}
                  </Line>
                </>
              )}

              {/* Last price reference line */}
              {last && (
                <ReferenceLine
                  yAxisId="price"
                  y={last.close}
                  stroke={lineColor}
                  strokeDasharray="2 3"
                  strokeOpacity={0.5}
                >
                  <Label
                    value={fmt(last.close)}
                    position="right"
                    fill={lineColor}
                    fontSize={10}
                    fontWeight={700}
                  />
                </ReferenceLine>
              )}

              {/* Period high/low reference lines */}
              {showRange && periodHigh != null && (
                <ReferenceLine
                  yAxisId="price"
                  y={periodHigh}
                  stroke="rgb(72,166,152)"
                  strokeOpacity={0.4}
                  strokeDasharray="6 3"
                >
                  <Label
                    value={`H ${fmt(periodHigh)}`}
                    position="left"
                    fill="rgb(72,166,152)"
                    fontSize={9}
                    fontWeight={600}
                  />
                </ReferenceLine>
              )}
              {showRange && periodLow != null && (
                <ReferenceLine
                  yAxisId="price"
                  y={periodLow}
                  stroke="rgb(220,72,72)"
                  strokeOpacity={0.4}
                  strokeDasharray="6 3"
                >
                  <Label
                    value={`L ${fmt(periodLow)}`}
                    position="left"
                    fill="rgb(220,72,72)"
                    fontSize={9}
                    fontWeight={600}
                  />
                </ReferenceLine>
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Volume pane — separated for proper proportion */}
          {showVolume && (
            <ResponsiveContainer width="100%" height={Math.round(height * 0.22)}>
              <ComposedChart
                data={data}
                syncId="stock-chart"
                margin={{ top: 0, right: 56, bottom: 4, left: 0 }}
              >
                <CartesianGrid
                  stroke="var(--border-subtle)"
                  strokeOpacity="0.3"
                  vertical={false}
                />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: 'var(--txt-muted)' }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  minTickGap={40}
                />
                <YAxis
                  yAxisId="volume"
                  domain={[0, 'auto']}
                  tick={{ fontSize: 9, fill: 'var(--txt-muted)' }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  orientation="right"
                  tickFormatter={(v) => fmtVol(Number(v))}
                  tickCount={3}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--border-default)', strokeOpacity: 0.6, strokeDasharray: '3 3' }}
                  content={() => null}
                />
                <Bar
                  yAxisId="volume"
                  dataKey="volume"
                  shape={(props: unknown) => (
                    <VolumeShape {...(props as VolumeShapeProps)} upColor={upColor} downColor={downColor} />
                  )}
                  isAnimationActive={false}
                />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── Legend strip (when MA enabled) ──────────────────────────── */}
      {showMA && data.length > 0 && (
        <div className="flex items-center gap-3 text-[10px] text-txt-muted px-1 pt-1">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: '#F59E0B' }} />
            MA 20일선
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: '#A855F7' }} />
            MA 60일선
          </span>
          {showRange && (
            <>
              <span className="flex items-center gap-1.5 ml-2">
                <span
                  className="inline-block w-3 h-0.5 rounded-full"
                  style={{ background: 'rgb(72,166,152)', opacity: 0.6 }}
                />
                기간 최고
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="inline-block w-3 h-0.5 rounded-full"
                  style={{ background: 'rgb(220,72,72)', opacity: 0.6 }}
                />
                기간 최저
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: ChartRow;
  upColor: string;
  downColor: string;
}
function CandleShape(p: CandleShapeProps) {
  if (p.x == null || p.y == null || p.width == null || p.height == null || !p.payload) return null;
  const cx = p.x + p.width / 2;
  const color = p.payload.isUp ? p.upColor : p.downColor;

  const w = Math.min(14, Math.max(4, p.width * 0.88));
  const bodyX = cx - w / 2;

  const { open, close, low, high } = p.payload;
  const wickRange = high - low;
  const px = (v: number) =>
    wickRange === 0 ? p.y! + p.height! / 2 : p.y! + ((high - v) / wickRange) * p.height!;
  const bodyTop = px(Math.max(open, close));
  const bodyBottom = px(Math.min(open, close));
  const bodyH = Math.max(2, bodyBottom - bodyTop);

  const r = Math.min(2, w / 4);
  const sw = p.width >= 6 ? 1.75 : 1.25;

  return (
    <g>
      <line
        x1={cx}
        x2={cx}
        y1={p.y}
        y2={p.y + p.height}
        stroke={color}
        strokeWidth={sw}
        strokeLinecap="round"
        opacity={0.95}
      />
      <rect
        x={bodyX}
        y={bodyTop}
        width={w}
        height={bodyH}
        rx={r}
        ry={r}
        fill={color}
        fillOpacity={0.92}
        stroke={color}
        strokeOpacity={0.85}
        strokeWidth={1}
      />
      {bodyH >= 6 && (
        <rect
          x={bodyX + 1}
          y={bodyTop + 1}
          width={Math.max(0, w - 2)}
          height={Math.max(0, bodyH - 2)}
          rx={Math.max(0, r - 0.5)}
          ry={Math.max(0, r - 0.5)}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={0.75}
        />
      )}
    </g>
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
      fillOpacity={0.45}
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
  const changeColor = row.isUp
    ? variant === 'kr' ? '#F26D6D' : '#3DD68C'
    : variant === 'kr' ? '#5BA8F2' : '#F26D6D';
  const dayChange = row.close - row.open;
  const dayChangePct = (dayChange / row.open) * 100;
  return (
    <div className="rounded-md border border-border-default bg-bg-secondary/95 backdrop-blur-sm p-2.5 text-[11px] shadow-lg min-w-[180px]">
      <div className="text-txt-secondary text-[10px] font-mono mb-1.5 pb-1 border-b border-border-subtle/40">
        {row.date}
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
        <span className="text-txt-muted">시가 (O)</span>
        <span className="text-right font-mono">{fmt(row.open)}</span>
        <span className="text-txt-muted">고가 (H)</span>
        <span className="text-right font-mono text-status-success">{fmt(row.high)}</span>
        <span className="text-txt-muted">저가 (L)</span>
        <span className="text-right font-mono text-status-danger">{fmt(row.low)}</span>
        <span className="text-txt-muted">종가 (C)</span>
        <span className="text-right font-mono font-semibold" style={{ color: changeColor }}>
          {fmt(row.close)}
        </span>
        <span className="text-txt-muted">일중 변동</span>
        <span className="text-right font-mono font-semibold" style={{ color: changeColor }}>
          {dayChange >= 0 ? '+' : ''}
          {fmt(dayChange)} ({dayChangePct >= 0 ? '+' : ''}
          {dayChangePct.toFixed(2)}%)
        </span>
        {row.volume > 0 && (
          <>
            <span className="text-txt-muted">거래량</span>
            <span className="text-right font-mono">{row.volume.toLocaleString()}</span>
          </>
        )}
        {row.ma20 != null && (
          <>
            <span className="text-txt-muted">MA20</span>
            <span className="text-right font-mono" style={{ color: '#F59E0B' }}>
              {fmt(row.ma20)}
            </span>
          </>
        )}
        {row.ma60 != null && (
          <>
            <span className="text-txt-muted">MA60</span>
            <span className="text-right font-mono" style={{ color: '#A855F7' }}>
              {fmt(row.ma60)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
