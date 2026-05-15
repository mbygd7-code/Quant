'use client';

/**
 * FullscreenChartViewer
 * ---------------------------------------------------------------
 * Pro-grade chart viewer rendered on its own page. Builds on the
 * same /api/{kr,us}-chart data feed used by the compact StockChart
 * but adds the controls professionals expect:
 *
 *   • Extended period set (1D, 5D, 1W, 1M, 3M, 6M, YTD, 1Y, 5Y, ALL)
 *     — gracefully falls back to whatever the API can serve.
 *   • Chart types: 캔들 / 라인 / 영역 (area).
 *   • Independently toggleable MA periods: 5, 20, 60, 120일.
 *   • Bollinger Bands (MA20 ± 2σ, computed client-side from closes).
 *   • RSI(14) pane — momentum oscillator, the most common indicator
 *     traders glance at alongside price.
 *   • Linear / Log Y scale toggle (log makes multi-year charts honest).
 *   • Compare overlay — load a second symbol (KOSPI ^KS11 by default)
 *     and normalize to first-day return so % motion is comparable.
 *   • Detailed crosshair tooltip with all OHLCV + indicator values.
 *   • Sticky toolbar so controls remain reachable on very long pages.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────
export type FsPeriod =
  | '1d' | '5d' | '1w' | '1m' | '3m' | '6m' | 'ytd' | '1y' | '5y' | 'all';
export type FsMode = 'candle' | 'line' | 'area';
export type FsScale = 'linear' | 'log';

interface RawCandle {
  date?: string;
  t?: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface Row {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  rsi: number | null;
  comparePct: number | null;
  closePct: number;          // % vs first close in period (own series)
  isUp: boolean;
  /** [low, high] tuple — Recharts uses this to position the candle
   *  Bar across its true Y range. Without a range dataKey the bar
   *  would render from 0..high which is meaningless for OHLC. */
  wick: [number, number];
}

// ── Computations ─────────────────────────────────────────────────
function sma(xs: number[], w: number): (number | null)[] {
  const out: (number | null)[] = new Array(xs.length).fill(null);
  if (xs.length < w) return out;
  let sum = 0;
  for (let i = 0; i < w; i++) sum += xs[i];
  out[w - 1] = sum / w;
  for (let i = w; i < xs.length; i++) {
    sum += xs[i] - xs[i - w];
    out[i] = sum / w;
  }
  return out;
}

/** Bollinger Bands: MA20 ± 2 × rolling stdev(20). */
function bollinger(closes: number[], w = 20, mult = 2): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < w) return { upper, lower };
  for (let i = w - 1; i < closes.length; i++) {
    const slice = closes.slice(i - w + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / w;
    const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / w;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { upper, lower };
}

/** Wilder's RSI(14). Standard momentum oscillator, 0..100. */
function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// API supports up to '1y'; for longer periods we fall back to 1y data
// (server will be extended in a follow-up). User sees the slice we have.
const PERIOD_TO_API: Record<FsPeriod, string> = {
  '1d': '1d',          // intraday 5-min, single day
  '5d': '1w_intra',    // intraday 30-min × 5 trading days = 65 bars
  '1w': '1w_intra',    // same as 5D — 30-min intraday view
  '1m': '1m',
  '3m': '3m',
  '6m': '1y',
  ytd: '1y',
  '1y': '1y',
  '5y': '1y',
  all: '1y',
};

/** Periods that return intraday/multi-day-intraday data and need
 *  custom X-axis tick logic so day boundaries render as MM-DD labels
 *  instead of HH:MM clutter or compressed scientific notation. */
const INTRADAY_PERIODS = new Set<FsPeriod>(['1d', '5d', '1w']);

/** Crosshair styling for the chart cursor. Used across all three
 *  panes (price / volume / RSI) so the vertical line reads as ONE
 *  continuous trace through the syncId'd composition. Previously the
 *  default Recharts dashed cursor was too faint to scan against the
 *  candle wicks — bumped to a brand-purple solid line with explicit
 *  width so it's immediately visible without competing with price
 *  lines. */
const CROSSHAIR_CURSOR = {
  stroke: 'rgb(114,60,235)',       // brand purple — high contrast on both themes
  strokeWidth: 1.4,
  strokeOpacity: 0.85,
  strokeDasharray: '4 3',
} as const;

const PERIODS: { id: FsPeriod; label: string; hint?: string }[] = [
  { id: '1d', label: '1D' },
  { id: '5d', label: '5D' },
  { id: '1w', label: '1W' },
  { id: '1m', label: '1M' },
  { id: '3m', label: '3M' },
  { id: '6m', label: '6M' },
  { id: 'ytd', label: 'YTD' },
  { id: '1y', label: '1Y' },
  { id: '5y', label: '5Y', hint: '※ 데이터는 최대 1Y' },
  { id: 'all', label: 'ALL', hint: '※ 데이터는 최대 1Y' },
];

/** Common index / ETF tickers → 한글 라벨. Used both in the recent-
 *  compares dropdown and as a fallback when the stocks table doesn't
 *  have a row for the symbol (indices are not in the `stocks` master
 *  table). Extend as users request new entries. */
const SYMBOL_LABEL_MAP: Record<string, string> = {
  '^KS11': '코스피',
  '^KQ11': '코스닥',
  '^IXIC': '나스닥',
  '^GSPC': 'S&P 500',
  '^DJI': '다우존스',
  '^N225': '닛케이',
  '^HSI': '항셍',
  SPY: 'SPDR S&P 500',
  QQQ: 'Invesco QQQ',
};

interface RecentCompare {
  symbol: string;
  /** Human-readable label (한글 종목명 또는 지수명). Falls back to
   *  symbol when no name could be resolved. */
  label: string;
}

const RECENTS_KEY = 'chart:fs:recent-compares';
const RECENTS_MAX = 5;

function loadRecents(): RecentCompare[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as RecentCompare[]).filter(
      (r) => r && typeof r.symbol === 'string' && typeof r.label === 'string',
    ).slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function saveRecents(list: RecentCompare[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    /* quota / disabled — silent */
  }
}

/** Resolve a ticker/index symbol to a 한글 label. Indices use the
 *  built-in map; 6-digit KR tickers go through /api/stocks/resolve. */
async function resolveLabel(symbol: string): Promise<string> {
  const sym = symbol.trim();
  if (!sym) return sym;
  // Known index / ETF
  if (SYMBOL_LABEL_MAP[sym]) return SYMBOL_LABEL_MAP[sym];
  if (SYMBOL_LABEL_MAP[sym.toUpperCase()]) return SYMBOL_LABEL_MAP[sym.toUpperCase()];
  // 6-digit KR ticker — hit stocks master table
  if (/^\d{6}$/.test(sym)) {
    try {
      const r = await fetch(`/api/stocks/resolve?tickers=${sym}`);
      const j = (await r.json()) as { items?: Array<{ ticker: string; name?: string }> };
      const item = j.items?.find((x) => x.ticker === sym);
      if (item?.name) return item.name;
    } catch {
      /* fall through to symbol fallback */
    }
  }
  return sym;
}

interface Props {
  ticker: string;
  variant: 'kr' | 'us';
  symbol?: string;
  /** Display name (e.g. '삼성SDI'). Server-resolved from the `stocks`
   *  table when available; falls back to `null` and we just show the
   *  ticker. */
  stockName?: string | null;
  /** Sector for an optional small badge in the header. */
  sector?: string | null;
  initialPeriod?: FsPeriod;
  initialMode?: FsMode;
}

export function FullscreenChartViewer({
  ticker,
  variant,
  symbol,
  stockName,
  sector,
  initialPeriod = '3m',
  initialMode = 'candle',
}: Props) {
  // ── State ────────────────────────────────────────────────────
  const [period, setPeriod] = useState<FsPeriod>(initialPeriod);
  const [mode, setMode] = useState<FsMode>(initialMode);
  const [scale, setScale] = useState<FsScale>('linear');
  const [showVolume, setShowVolume] = useState(true);
  const [showRsi, setShowRsi] = useState(false);
  const [showBollinger, setShowBollinger] = useState(false);
  const [showRange, setShowRange] = useState(true);
  // MA toggles — each independent so users can show only MA20 etc.
  const [showMa, setShowMa] = useState<Record<5 | 20 | 60 | 120, boolean>>({
    5: false, 20: true, 60: true, 120: false,
  });
  // Compare overlay — default to KOSPI for KR, S&P for US.
  const [compareSymbol, setCompareSymbol] = useState<string>('');
  const [compareEnabled, setCompareEnabled] = useState(false);
  // Recent-compares dropdown — populated from localStorage on mount,
  // re-saved whenever a new compare is activated. Shows on input
  // focus or hover so the user can re-use a previous comparison in
  // one click instead of retyping the ticker.
  const [recents, setRecents] = useState<RecentCompare[]>([]);
  const [recentsOpen, setRecentsOpen] = useState(false);
  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  // When user activates compare with a valid symbol, push it to the
  // recents list (deduped, head-of-list, max 5). Display label is
  // resolved via the indices map + stocks table lookup.
  useEffect(() => {
    if (!compareEnabled || !compareSymbol.trim()) return;
    const sym = compareSymbol.trim();
    let cancelled = false;
    void resolveLabel(sym).then((label) => {
      if (cancelled) return;
      setRecents((prev) => {
        const next = [
          { symbol: sym, label },
          ...prev.filter((r) => r.symbol !== sym),
        ].slice(0, RECENTS_MAX);
        saveRecents(next);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [compareEnabled, compareSymbol]);

  const pickRecent = (r: RecentCompare) => {
    setCompareSymbol(r.symbol);
    setCompareEnabled(true);
    setRecentsOpen(false);
  };

  // ── Data fetch ───────────────────────────────────────────────
  const [raw, setRaw] = useState<RawCandle[]>([]);
  const [compareRaw, setCompareRaw] = useState<RawCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiPeriod = PERIOD_TO_API[period];

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const url =
      variant === 'kr'
        ? `/api/kr-chart?ticker=${encodeURIComponent(ticker)}&period=${apiPeriod}`
        : `/api/us-chart?symbol=${encodeURIComponent(symbol ?? ticker)}&period=${apiPeriod}`;
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
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'fetch failed'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [ticker, symbol, variant, apiPeriod]);

  useEffect(() => {
    if (!compareEnabled || !compareSymbol) {
      setCompareRaw([]);
      return;
    }
    let cancelled = false;
    const isKrCompare = /^\d{6}$/.test(compareSymbol) || compareSymbol.startsWith('^KS');
    const url = isKrCompare
      ? `/api/kr-chart?ticker=${encodeURIComponent(compareSymbol)}&period=${apiPeriod}`
      : `/api/us-chart?symbol=${encodeURIComponent(compareSymbol)}&period=${apiPeriod}`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: RawCandle[] }) => {
        if (cancelled) return;
        setCompareRaw(j.candles ?? []);
      })
      .catch(() => !cancelled && setCompareRaw([]));
    return () => { cancelled = true; };
  }, [compareEnabled, compareSymbol, apiPeriod]);

  // ── Transform ────────────────────────────────────────────────
  const data: Row[] = useMemo(() => {
    if (raw.length === 0) return [];
    const valid = raw.filter(
      (c) =>
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close),
    );
    if (valid.length === 0) return [];

    const closes = valid.map((c) => c.close);
    const ma5 = sma(closes, 5);
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, 60);
    const ma120 = sma(closes, 120);
    const { upper: bbU, lower: bbL } = bollinger(closes, 20, 2);
    const rsiSeries = rsi(closes, 14);

    // Compare overlay normalised to % return so different price
    // scales (e.g. ₩45k stock vs ^KS11 = 2600) can share a Y axis.
    const cmpMap = new Map<string, number>();
    if (compareRaw.length > 0) {
      const cmpValid = compareRaw.filter(
        (c) => Number.isFinite(c.close) && (c.date != null || c.t != null),
      );
      const firstClose = cmpValid[0]?.close;
      if (firstClose && firstClose > 0) {
        for (const c of cmpValid) {
          const d = c.date ?? (c.t ? new Date(c.t).toISOString().slice(0, INTRADAY_PERIODS.has(period) ? 16 : 10) : '');
          cmpMap.set(d, ((c.close - firstClose) / firstClose) * 100);
        }
      }
    }
    const firstClose = closes[0];

    return valid.map((c, i): Row => {
      const date = c.date ?? (c.t ? new Date(c.t).toISOString().slice(0, INTRADAY_PERIODS.has(period) ? 16 : 10) : '');
      return {
        date,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0,
        ma5: ma5[i],
        ma20: ma20[i],
        ma60: ma60[i],
        ma120: ma120[i],
        bbUpper: bbU[i],
        bbLower: bbL[i],
        rsi: rsiSeries[i],
        comparePct: cmpMap.get(date) ?? null,
        closePct: firstClose > 0 ? ((c.close - firstClose) / firstClose) * 100 : 0,
        isUp: c.close >= c.open,
        wick: [c.low, c.high] as [number, number],
      };
    });
  }, [raw, compareRaw, period]);

  // ── Derived stats ────────────────────────────────────────────
  const last = data[data.length - 1] ?? null;
  const first = data[0]?.close ?? null;
  const isUp = first != null && last != null ? last.close >= first : null;
  const change = first != null && last != null ? last.close - first : null;
  const changePct = first != null && last != null ? ((last.close - first) / first) * 100 : null;

  const periodHigh = useMemo(
    () => (data.length === 0 ? null : Math.max(...data.map((d) => d.high))),
    [data],
  );
  const periodLow = useMemo(
    () => (data.length === 0 ? null : Math.min(...data.map((d) => d.low))),
    [data],
  );
  const periodOpen = data[0]?.open ?? null;
  const periodVolumeSum = useMemo(
    () => data.reduce((acc, d) => acc + (Number.isFinite(d.volume) ? d.volume : 0), 0),
    [data],
  );

  // Day-boundary ticks for intraday views.
  // 1W (30-min intraday) has 65 bars but only ~5 trading days — we want
  // exactly one X-axis label per day, anchored on the first bar of each
  // day. Without explicit `ticks`, Recharts would either label every
  // 30-min slot (cluttered) or pick arbitrary indices.
  // For 1D (single-day 5-min), we want hourly labels — so we use a
  // different stride.
  const intradayTicks = useMemo(() => {
    if (!INTRADAY_PERIODS.has(period) || data.length === 0) return undefined;
    if (period === '1d') {
      // 1D: one tick per hour. Bar timestamps look like 'YYYY-MM-DD HH:MM'.
      const seen = new Set<string>();
      const out: string[] = [];
      for (const row of data) {
        const hour = row.date.slice(0, 13);  // 'YYYY-MM-DD HH'
        if (!seen.has(hour)) {
          seen.add(hour);
          out.push(row.date);
        }
      }
      return out;
    }
    // 1W / 5D: one tick per trading day, anchored on first bar of that day.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of data) {
      const day = row.date.slice(0, 10);
      if (!seen.has(day)) {
        seen.add(day);
        out.push(row.date);
      }
    }
    return out;
  }, [period, data]);

  // tickFormatter: strip time portion for intraday multi-day views;
  // 1D shows HH:MM; daily views show MM-DD as-is.
  const xTickFormatter = (v: string): string => {
    if (!v) return '';
    if (period === '1d') {
      // 'YYYY-MM-DD HH:MM' → 'HH:MM'
      return v.length >= 16 ? v.slice(11, 16) : v;
    }
    if (INTRADAY_PERIODS.has(period)) {
      // 'YYYY-MM-DD HH:MM' → 'MM-DD'
      return v.length >= 10 ? v.slice(5, 10) : v;
    }
    // daily — original behaviour ('YYYY-MM-DD' shown shortened)
    return v.length >= 10 ? v.slice(5, 10) : v;
  };

  // Palette — KR red=up, US green=up (Korean trading convention).
  const upColor = variant === 'kr' ? '#F26D6D' : '#3DD68C';
  const downColor = variant === 'kr' ? '#5BA8F2' : '#F26D6D';
  const lineColor = isUp === false ? downColor : upColor;

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

  // ── Render ───────────────────────────────────────────────────
  const priceHeight = showRsi && showVolume ? 480 : showRsi || showVolume ? 540 : 620;
  const volumeHeight = 110;
  const rsiHeight = 110;

  const compareLabel = compareEnabled && compareSymbol
    ? compareSymbol.toUpperCase()
    : '';

  return (
    <div className="space-y-3">
      {/* ── Header bar ──────────────────────────────────────────
          Layout: [뒤로] [종목명 + 티커 + 현재가 + 등락 + 섹터배지] ⇢ [OHLV 통계]
          Stock name and live price/change sit INLINE so the user
          immediately sees what they're looking at. OHLV bar slides
          to the right and only shows period-aggregated stats. */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <Link
            href={`/stocks/${variant}/${ticker}`}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-border-subtle/40 bg-bg-secondary/40 hover:bg-bg-tertiary/60 hover:border-brand-purple/40 text-[12px] font-medium text-txt-secondary hover:text-brand-purple transition-colors"
            title="종목 상세로 돌아가기"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
            뒤로
          </Link>

          {/* Identity + live price — one continuous baseline */}
          <div className="flex items-baseline gap-3 flex-wrap">
            <h1 className="text-xl font-bold tracking-tight">
              {stockName ?? ticker}
            </h1>
            {stockName && (
              <span className="text-[12px] font-mono text-txt-muted tabular-nums">
                {ticker}
              </span>
            )}
            {sector && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-brand-purple/10 text-brand-purple border border-brand-purple/20">
                {sector}
              </span>
            )}

            {/* Live price + change directly next to the name */}
            {!loading && !error && last && (
              <>
                <span
                  className="font-mono text-xl font-bold tabular-nums"
                  style={{ color: lineColor }}
                >
                  {fmt(last.close)}
                </span>
                {change != null && changePct != null && (
                  <span
                    className="inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded-md text-[12px] font-mono tabular-nums font-semibold"
                    style={{
                      color: lineColor,
                      background: `${lineColor}1A`,           // ~10% tint
                      border: `1px solid ${lineColor}33`,    // ~20% border
                    }}
                    title={`기간(${period.toUpperCase()}) 시초가 대비 변동`}
                  >
                    <span aria-hidden>{change >= 0 ? '▲' : '▼'}</span>
                    {change >= 0 ? '+' : ''}{fmt(change)}
                    <span className="opacity-80">
                      ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
                    </span>
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        {!loading && !error && last && (
          <div
            className="flex items-baseline gap-3 text-[11px] tabular-nums px-3 py-2 rounded-md bg-bg-secondary/40 border border-border-subtle/40"
            title={`선택 기간(${period.toUpperCase()}) 기준 — O=시초가, H=최고가, L=최저가, V=누적 거래량`}
          >
            <span className="text-txt-muted">O <span className="text-txt-primary font-mono">{fmt(periodOpen)}</span></span>
            <span className="text-txt-muted">H <span className="font-mono text-status-success">{fmt(periodHigh)}</span></span>
            <span className="text-txt-muted">L <span className="font-mono text-status-danger">{fmt(periodLow)}</span></span>
            <span className="text-txt-muted">V <span className="text-txt-primary font-mono">{fmtVol(periodVolumeSum)}</span></span>
          </div>
        )}
      </div>

      {/* ── Sticky toolbar ─────────────────────────────────── */}
      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-bg-primary/95 backdrop-blur-sm border-b border-border-subtle/30 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Periods */}
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
                title={p.hint}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Chart type */}
          <div className="flex rounded-md bg-bg-secondary/40 p-0.5 border border-border-subtle/40">
            {(['candle', 'line', 'area'] as FsMode[]).map((m) => (
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
                {m === 'candle' ? '캔들' : m === 'line' ? '라인' : '영역'}
              </button>
            ))}
          </div>

          {/* Scale */}
          <div className="flex rounded-md bg-bg-secondary/40 p-0.5 border border-border-subtle/40">
            {(['linear', 'log'] as FsScale[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScale(s)}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-semibold transition-all rounded',
                  scale === s
                    ? 'bg-brand-purple text-white shadow-sm'
                    : 'text-txt-secondary hover:text-txt-primary',
                )}
                title={s === 'log' ? '로그 스케일 — 장기 차트에서 비율적 변화를 정직하게 표현' : '선형 스케일'}
              >
                {s === 'linear' ? '선형' : '로그'}
              </button>
            ))}
          </div>

          <ToolbarToggle on={showVolume} onClick={() => setShowVolume((v) => !v)} title="거래량 페인">Vol</ToolbarToggle>
          <ToolbarToggle on={showRsi} onClick={() => setShowRsi((v) => !v)} title="RSI(14) 모멘텀 지표 (30 과매도 / 70 과매수)">RSI</ToolbarToggle>
          <ToolbarToggle on={showBollinger} onClick={() => setShowBollinger((v) => !v)} title="Bollinger Bands (MA20 ± 2σ) — 변동성 범위">BB</ToolbarToggle>
          <ToolbarToggle on={showRange} onClick={() => setShowRange((v) => !v)} title="기간 최고/최저선">H/L</ToolbarToggle>
        </div>

        {/* MA + Compare row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] text-txt-muted px-1">MA:</span>
          {([5, 20, 60, 120] as const).map((w) => (
            <ToolbarToggle
              key={w}
              on={showMa[w]}
              onClick={() => setShowMa((prev) => ({ ...prev, [w]: !prev[w] }))}
              title={`${w}일 이동평균선`}
            >
              {w}
            </ToolbarToggle>
          ))}

          <span className="ml-3 text-[10px] text-txt-muted px-1">비교:</span>
          {/* Compare input with recent-compares dropdown.
              - Korean placeholder examples so first-time users know
                they can type 종목명 or 지수명.
              - Dropdown opens on focus/mouseenter, lists up to 5
                previous comparisons (한글 라벨), one-click re-apply.
              - mouseleave + onBlur close it so it doesn't linger. */}
          <div
            className="relative"
            onMouseEnter={() => recents.length > 0 && setRecentsOpen(true)}
            onMouseLeave={() => setRecentsOpen(false)}
          >
            <input
              type="text"
              value={compareSymbol}
              onChange={(e) => setCompareSymbol(e.target.value)}
              onFocus={() => recents.length > 0 && setRecentsOpen(true)}
              onClick={(e) => {
                // Explicit click selects all so the user can immediately
                // overwrite the previous symbol without first clearing.
                (e.target as HTMLInputElement).select();
              }}
              placeholder={variant === 'kr' ? '예: 코스피, 삼성전자' : 'e.g. SPY, AAPL'}
              className="px-2 py-1 text-[11px] font-mono rounded-md border border-border-subtle/40 bg-bg-secondary/40 focus:border-brand-purple/60 focus:outline-none w-[160px]"
            />
            {recentsOpen && recents.length > 0 && (
              <div
                className="absolute left-0 top-full mt-1 z-20 w-[220px] rounded-md border border-border-default bg-bg-secondary/95 backdrop-blur-sm shadow-lg py-1 text-[11px]"
                role="listbox"
                aria-label="최근 비교 종목"
              >
                <div className="px-2.5 py-1 text-[10px] text-txt-muted border-b border-border-subtle/40 mb-1 flex items-center justify-between">
                  <span>최근 비교 종목</span>
                  {recents.length > 0 && (
                    <button
                      type="button"
                      className="text-txt-muted hover:text-status-danger transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRecents([]);
                        saveRecents([]);
                        setRecentsOpen(false);
                      }}
                      title="최근 목록 비우기"
                    >
                      비우기
                    </button>
                  )}
                </div>
                {recents.map((r) => (
                  <button
                    key={r.symbol}
                    type="button"
                    role="option"
                    aria-selected={compareSymbol === r.symbol}
                    onClick={() => pickRecent(r)}
                    className={cn(
                      'w-full text-left px-2.5 py-1.5 flex items-baseline justify-between gap-2 transition-colors',
                      compareSymbol === r.symbol
                        ? 'bg-brand-purple/15 text-brand-purple'
                        : 'hover:bg-bg-tertiary/60 text-txt-primary',
                    )}
                  >
                    <span className="font-medium truncate">{r.label}</span>
                    <span className="font-mono text-[10px] text-txt-muted shrink-0">
                      {r.symbol}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <ToolbarToggle
            on={compareEnabled && compareSymbol.length > 0}
            onClick={() => setCompareEnabled((v) => !v)}
            title="입력한 종목/지수의 % 변동을 normalised 라인으로 overlay"
          >
            비교 ON
          </ToolbarToggle>
          {compareEnabled && compareLabel && (
            <span className="text-[10px] text-status-info font-medium">
              vs {compareLabel}
            </span>
          )}
        </div>
      </div>

      {/* ── Chart panes ─────────────────────────────────────── */}
      {loading ? (
        <div className="w-full rounded bg-bg-tertiary/40 animate-pulse" style={{ height: priceHeight }} />
      ) : error ? (
        <div className="text-sm text-status-danger px-2 py-3">차트 로드 실패: {error}</div>
      ) : data.length === 0 ? (
        <div className="rounded-md border border-border-subtle/40 bg-bg-secondary/30 px-4 py-12 text-center">
          <div className="text-sm text-txt-secondary mb-1">차트 데이터 없음</div>
          <div className="text-xs text-txt-muted">선택한 기간의 데이터를 불러올 수 없습니다.</div>
        </div>
      ) : (
        <div className="space-y-0">
          {/* Price pane */}
          <ResponsiveContainer width="100%" height={priceHeight}>
            <ComposedChart data={data} syncId="fs-chart" margin={{ top: 12, right: 64, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--border-subtle)" strokeOpacity="0.5" strokeDasharray="2 4" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'var(--txt-muted)' }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={50}
                ticks={intradayTicks}
                tickFormatter={xTickFormatter}
                hide
              />
              <YAxis
                yAxisId="price"
                // Log scale needs strictly positive bounds; use function-domain
                // pair so both ends are dynamic. Linear uses 'auto' tuple.
                domain={
                  scale === 'log'
                    ? [(dmin: number) => Math.max(1, dmin * 0.95), (dmax: number) => dmax * 1.05]
                    : ['auto', 'auto']
                }
                scale={scale === 'log' ? 'log' : 'auto'}
                allowDataOverflow={scale === 'log'}
                tick={{ fontSize: 11, fill: 'var(--txt-muted)' }}
                axisLine={false}
                tickLine={false}
                width={64}
                orientation="right"
                tickFormatter={(v) => fmt(Number(v))}
              />
              {/* Compare overlay shares its own Y axis (% return) so it
                  doesn't get crushed onto the price axis. */}
              {compareEnabled && compareRaw.length > 0 && (
                <YAxis
                  yAxisId="compare"
                  orientation="left"
                  width={48}
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 10, fill: 'var(--status-info)' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`}
                />
              )}
              <Tooltip
                cursor={CROSSHAIR_CURSOR}
                content={(p: unknown) => (
                  <FullscreenTooltip raw={p} variant={variant} compareLabel={compareLabel} />
                )}
              />

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
              {mode === 'line' && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="close"
                  stroke={lineColor}
                  strokeWidth={1.8}
                  dot={false}
                  isAnimationActive={false}
                />
              )}
              {mode === 'area' && (
                <Area
                  yAxisId="price"
                  type="monotone"
                  dataKey="close"
                  stroke={lineColor}
                  strokeWidth={1.6}
                  fill={lineColor}
                  fillOpacity={0.15}
                  isAnimationActive={false}
                />
              )}

              {/* Moving averages */}
              {showMa[5] && (
                <Line yAxisId="price" type="monotone" dataKey="ma5" stroke="#22D3EE" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
              )}
              {showMa[20] && (
                <Line yAxisId="price" type="monotone" dataKey="ma20" stroke="#F59E0B" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
              )}
              {showMa[60] && (
                <Line yAxisId="price" type="monotone" dataKey="ma60" stroke="#A855F7" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
              )}
              {showMa[120] && (
                <Line yAxisId="price" type="monotone" dataKey="ma120" stroke="#EC4899" strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />
              )}

              {/* Bollinger Bands */}
              {showBollinger && (
                <>
                  <Line yAxisId="price" type="monotone" dataKey="bbUpper" stroke="rgba(168,85,247,0.55)" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls isAnimationActive={false} />
                  <Line yAxisId="price" type="monotone" dataKey="bbLower" stroke="rgba(168,85,247,0.55)" strokeWidth={1} strokeDasharray="3 3" dot={false} connectNulls isAnimationActive={false} />
                </>
              )}

              {/* Compare overlay */}
              {compareEnabled && compareRaw.length > 0 && (
                <Line
                  yAxisId="compare"
                  type="monotone"
                  dataKey="comparePct"
                  stroke="rgb(91,168,242)"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              )}

              {/* Period H/L lines */}
              {showRange && periodHigh != null && (
                <ReferenceLine
                  yAxisId="price"
                  y={periodHigh}
                  stroke="rgb(72,166,152)"
                  strokeOpacity={0.45}
                  strokeDasharray="6 3"
                  label={{ value: `H ${fmt(periodHigh)}`, position: 'insideTopLeft', fill: 'rgb(72,166,152)', fontSize: 10, fontWeight: 700 }}
                />
              )}
              {showRange && periodLow != null && (
                <ReferenceLine
                  yAxisId="price"
                  y={periodLow}
                  stroke="rgb(220,72,72)"
                  strokeOpacity={0.45}
                  strokeDasharray="6 3"
                  label={{ value: `L ${fmt(periodLow)}`, position: 'insideBottomLeft', fill: 'rgb(220,72,72)', fontSize: 10, fontWeight: 700 }}
                />
              )}

              {/* Live price badge */}
              {last && (
                <ReferenceLine
                  yAxisId="price"
                  y={last.close}
                  stroke={lineColor}
                  strokeDasharray="2 3"
                  strokeOpacity={0.7}
                  ifOverflow="extendDomain"
                  label={({ viewBox }: { viewBox?: { x?: number; y?: number; width?: number } }) => {
                    const x = (viewBox?.x ?? 0) + (viewBox?.width ?? 0);
                    const y = viewBox?.y ?? 0;
                    const text = fmt(last.close);
                    const w = Math.max(64, text.length * 7 + 14);
                    return (
                      <g transform={`translate(${x - 2}, ${y - 9})`}>
                        <rect width={w} height={18} rx={3} fill={lineColor} fillOpacity={0.95} />
                        <text x={w / 2} y={12} textAnchor="middle" fill="#FFFFFF" fontSize={11} fontWeight={700} style={{ fontFamily: 'ui-monospace, monospace' }}>
                          {text}
                        </text>
                      </g>
                    );
                  }}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>

          {/* Volume pane */}
          {showVolume && (
            <ResponsiveContainer width="100%" height={volumeHeight}>
              <ComposedChart data={data} syncId="fs-chart" margin={{ top: 0, right: 64, bottom: 4, left: 8 }}>
                <CartesianGrid stroke="var(--border-subtle)" strokeOpacity="0.3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--txt-muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={50} ticks={intradayTicks} tickFormatter={xTickFormatter} hide={showRsi} />
                <YAxis yAxisId="volume" domain={[0, 'auto']} tick={{ fontSize: 9, fill: 'var(--txt-muted)' }} axisLine={false} tickLine={false} width={64} orientation="right" tickFormatter={(v) => fmtVol(Number(v))} tickCount={3} />
                <Tooltip cursor={CROSSHAIR_CURSOR} content={() => null} />
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

          {/* RSI pane */}
          {showRsi && (
            <ResponsiveContainer width="100%" height={rsiHeight}>
              <ComposedChart data={data} syncId="fs-chart" margin={{ top: 4, right: 64, bottom: 8, left: 8 }}>
                <CartesianGrid stroke="var(--border-subtle)" strokeOpacity="0.3" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--txt-muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={50} ticks={intradayTicks} tickFormatter={xTickFormatter} />
                <YAxis yAxisId="rsi" domain={[0, 100]} ticks={[30, 50, 70]} tick={{ fontSize: 9, fill: 'var(--txt-muted)' }} axisLine={false} tickLine={false} width={64} orientation="right" />
                <Tooltip cursor={CROSSHAIR_CURSOR} content={() => null} />
                <ReferenceLine yAxisId="rsi" y={70} stroke="rgba(220,72,72,0.5)" strokeDasharray="3 3" />
                <ReferenceLine yAxisId="rsi" y={30} stroke="rgba(72,166,152,0.5)" strokeDasharray="3 3" />
                <Line yAxisId="rsi" type="monotone" dataKey="rsi" stroke="#A855F7" strokeWidth={1.4} dot={false} connectNulls isAnimationActive={false} />
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── Legend strip ────────────────────────────────────── */}
      {data.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-txt-muted px-2">
          {showMa[5] && <Swatch color="#22D3EE" label="MA 5일선" />}
          {showMa[20] && <Swatch color="#F59E0B" label="MA 20일선" />}
          {showMa[60] && <Swatch color="#A855F7" label="MA 60일선" />}
          {showMa[120] && <Swatch color="#EC4899" label="MA 120일선" />}
          {showBollinger && <Swatch color="rgba(168,85,247,0.6)" label="Bollinger ±2σ" />}
          {showRsi && <Swatch color="#A855F7" label="RSI(14)" />}
          {compareEnabled && compareLabel && <Swatch color="rgb(91,168,242)" label={`비교: ${compareLabel} (%)`} />}
          {showRange && (
            <>
              <Swatch color="rgb(72,166,152)" label="기간 최고" />
              <Swatch color="rgb(220,72,72)" label="기간 최저" />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────
function ToolbarToggle({
  on, onClick, title, children,
}: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'px-2.5 py-1 text-[11px] font-semibold rounded border transition-colors',
        on
          ? 'border-brand-purple/40 bg-brand-purple/10 text-brand-purple'
          : 'border-border-subtle/40 text-txt-muted hover:text-txt-primary',
      )}
    >
      {children}
    </button>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Row;
  upColor: string;
  downColor: string;
}
function CandleShape(p: CandleShapeProps) {
  if (p.x == null || p.y == null || p.width == null || p.height == null || !p.payload) return null;
  const cx = p.x + p.width / 2;
  const color = p.payload.isUp ? p.upColor : p.downColor;
  // Candle body widens proportionally with the column. Cap raised from
  // 16 → 40 so the 1M view (~20 daily candles across a 1400px canvas =
  // ~70px columns) no longer leaves huge whitespace gaps between bars.
  // Daily candles now visually 'connect' on monthly views while
  // intraday/yearly views still scale down to legible widths.
  const w = Math.min(40, Math.max(4, p.width * 0.78));
  const bodyX = cx - w / 2;
  const { open, close, low, high } = p.payload;
  const wickRange = high - low;
  const px = (v: number) =>
    wickRange === 0 ? p.y! + p.height! / 2 : p.y! + ((high - v) / wickRange) * p.height!;
  const bodyTop = px(Math.max(open, close));
  const bodyBottom = px(Math.min(open, close));
  const bodyH = Math.max(2, bodyBottom - bodyTop);
  const r = Math.min(2, w / 4);
  // Wick scales with column width too — a thin wick on a fat body
  // looks dated; pros use ~1/8 of body width.
  const wickW = Math.max(1.5, Math.min(3, w / 8));
  return (
    <g>
      <line
        x1={cx}
        x2={cx}
        y1={p.y}
        y2={p.y + p.height}
        stroke={color}
        strokeWidth={wickW}
        strokeLinecap="round"
        opacity={0.95}
      />
      <rect x={bodyX} y={bodyTop} width={w} height={bodyH} rx={r} ry={r} fill={color} fillOpacity={0.92} stroke={color} strokeWidth={1} />
    </g>
  );
}

interface VolumeShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: Row;
  upColor: string;
  downColor: string;
}
function VolumeShape(p: VolumeShapeProps) {
  if (p.x == null || p.y == null || p.width == null || p.height == null || !p.payload) return null;
  // Match the candle body width logic so volume bars align with their
  // price bars (especially noticeable on 1M views with fat candles).
  const w = Math.min(40, Math.max(1, p.width * 0.78));
  const offset = (p.width - w) / 2;
  const color = p.payload.isUp ? p.upColor : p.downColor;
  return <rect x={p.x + offset} y={p.y} width={w} height={p.height} fill={color} fillOpacity={0.5} />;
}

function FullscreenTooltip({
  raw, variant, compareLabel,
}: { raw: unknown; variant: 'kr' | 'us'; compareLabel: string }) {
  const r = raw as { active?: boolean; payload?: Array<{ payload?: Row }> } | null;
  if (!r?.active || !r.payload || r.payload.length === 0) return null;
  const row = r.payload[0]?.payload;
  if (!row) return null;
  const fmt = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return '—';
    return variant === 'kr'
      ? v.toLocaleString('ko-KR')
      : `$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  };
  const changeColor = row.isUp
    ? variant === 'kr' ? '#F26D6D' : '#3DD68C'
    : variant === 'kr' ? '#5BA8F2' : '#F26D6D';
  const dayChange = row.close - row.open;
  const dayChangePct = (dayChange / row.open) * 100;
  return (
    <div className="rounded-md border border-border-default bg-bg-secondary/95 backdrop-blur-sm p-3 text-[11px] shadow-lg min-w-[220px]">
      <div className="text-txt-secondary text-[10px] font-mono mb-1.5 pb-1 border-b border-border-subtle/40">{row.date}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
        <span className="text-txt-muted">시가 (O)</span><span className="text-right font-mono">{fmt(row.open)}</span>
        <span className="text-txt-muted">고가 (H)</span><span className="text-right font-mono text-status-success">{fmt(row.high)}</span>
        <span className="text-txt-muted">저가 (L)</span><span className="text-right font-mono text-status-danger">{fmt(row.low)}</span>
        <span className="text-txt-muted">종가 (C)</span>
        <span className="text-right font-mono font-semibold" style={{ color: changeColor }}>{fmt(row.close)}</span>
        <span className="text-txt-muted">일중 변동</span>
        <span className="text-right font-mono font-semibold" style={{ color: changeColor }}>
          {dayChange >= 0 ? '+' : ''}{fmt(dayChange)} ({dayChangePct >= 0 ? '+' : ''}{dayChangePct.toFixed(2)}%)
        </span>
        <span className="text-txt-muted">기간 누적</span>
        <span className="text-right font-mono" style={{ color: row.closePct >= 0 ? '#3DD68C' : '#F26D6D' }}>
          {row.closePct >= 0 ? '+' : ''}{row.closePct.toFixed(2)}%
        </span>
        {row.volume > 0 && (<>
          <span className="text-txt-muted">거래량</span><span className="text-right font-mono">{row.volume.toLocaleString()}</span>
        </>)}
        {row.ma5 != null && (<>
          <span className="text-txt-muted">MA5</span><span className="text-right font-mono" style={{ color: '#22D3EE' }}>{fmt(row.ma5)}</span>
        </>)}
        {row.ma20 != null && (<>
          <span className="text-txt-muted">MA20</span><span className="text-right font-mono" style={{ color: '#F59E0B' }}>{fmt(row.ma20)}</span>
        </>)}
        {row.ma60 != null && (<>
          <span className="text-txt-muted">MA60</span><span className="text-right font-mono" style={{ color: '#A855F7' }}>{fmt(row.ma60)}</span>
        </>)}
        {row.ma120 != null && (<>
          <span className="text-txt-muted">MA120</span><span className="text-right font-mono" style={{ color: '#EC4899' }}>{fmt(row.ma120)}</span>
        </>)}
        {row.bbUpper != null && row.bbLower != null && (<>
          <span className="text-txt-muted">BB ↑/↓</span>
          <span className="text-right font-mono" style={{ color: 'rgba(168,85,247,0.85)' }}>
            {fmt(row.bbUpper)} / {fmt(row.bbLower)}
          </span>
        </>)}
        {row.rsi != null && (<>
          <span className="text-txt-muted">RSI(14)</span>
          <span
            className="text-right font-mono"
            style={{ color: row.rsi >= 70 ? '#F26D6D' : row.rsi <= 30 ? '#3DD68C' : 'inherit' }}
          >
            {row.rsi.toFixed(1)}
          </span>
        </>)}
        {compareLabel && row.comparePct != null && (<>
          <span className="text-txt-muted">{compareLabel} %</span>
          <span className="text-right font-mono" style={{ color: row.comparePct >= 0 ? '#3DD68C' : '#F26D6D' }}>
            {row.comparePct >= 0 ? '+' : ''}{row.comparePct.toFixed(2)}%
          </span>
        </>)}
      </div>
    </div>
  );
}
