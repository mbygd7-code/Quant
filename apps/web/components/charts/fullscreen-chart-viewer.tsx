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
import { useEffect, useMemo, useRef, useState } from 'react';
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
  /** Volume metrics for the resizable volume pane. */
  volMa20: number | null;    // 20-day SMA of volume
  obv: number;               // On-Balance Volume cumulative
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

/** Predefined volume-pane size tiers. Each value lines up with one
 *  of the progressive-disclosure breakpoints in the volume pane so
 *  clicking a tier reliably unlocks the next layer of indicators:
 *    S  (90)  → bars + 평균/상대 거래량
 *    M  (170) → + 매수/매도 % + Volume MA(20)
 *    L  (240) → + OBV 라인 + OBV Δ 배지
 *    XL (380) → 모든 지표 여유롭게 표시
 */
const VOLUME_TIERS = [
  { id: 'S',  value: 90,  title: '작게 (90px) — 기본 막대 + 평균/상대 거래량' },
  { id: 'M',  value: 170, title: '보통 (170px) — + 매수/매도 비율 + Volume MA20' },
  { id: 'L',  value: 240, title: '크게 (240px) — + OBV 라인 + OBV Δ' },
  { id: 'XL', value: 380, title: '최대 (380px) — 전체 지표 + 여유 공간' },
] as const;

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
  /** Which chart API to hit. Stored so a re-applied recent doesn't
   *  have to re-resolve. */
  market: 'kr' | 'us';
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
      (r) =>
        r &&
        typeof r.symbol === 'string' &&
        typeof r.label === 'string' &&
        (r.market === 'kr' || r.market === 'us'),
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

/** Resolve ANY compare-input string to a chart-ready descriptor:
 *  what symbol to fetch, which API (kr/us), and a 한글 label to
 *  surface in the legend. Handles:
 *    • '^KS11', '^IXIC' …            → US chart API for indices
 *    • '005930'                       → KR chart API, name via stocks DB
 *    • '삼성전자' / '코스피'           → /api/stocks/search → resolve ticker
 *    • 'SPY', 'AAPL'                  → US chart API as-is
 *  Returns null when nothing usable was found. */
async function resolveCompare(
  raw: string,
): Promise<{ symbol: string; label: string; market: 'kr' | 'us' } | null> {
  const q = raw.trim();
  if (!q) return null;
  const upper = q.toUpperCase();

  // Built-in indices / ETFs first — these aren't in our stocks table.
  if (SYMBOL_LABEL_MAP[q]) {
    return { symbol: q, label: SYMBOL_LABEL_MAP[q], market: q.startsWith('^KS') || q.startsWith('^KQ') ? 'kr' : 'us' };
  }
  if (SYMBOL_LABEL_MAP[upper]) {
    return { symbol: upper, label: SYMBOL_LABEL_MAP[upper], market: upper.startsWith('^KS') || upper.startsWith('^KQ') ? 'kr' : 'us' };
  }
  // Generic '^XXX' tag → US chart with the symbol as label.
  if (/^\^[A-Z0-9]+$/i.test(q)) {
    return { symbol: upper, label: upper, market: 'us' };
  }
  // 6-digit Korean ticker → kr-chart, name from stocks master.
  if (/^\d{6}$/.test(q)) {
    const label = await resolveLabel(q);
    return { symbol: q, label, market: 'kr' };
  }
  // For anything else (Korean text, 'naver', 'kakao', etc.) try the
  // NAVER autocomplete first — it covers Korean stocks by both 한글
  // and Latin queries (e.g. 'naver' resolves to NAVER Corp 035420).
  // Only fall back to the US chart when the search returns nothing
  // AND the input looks like a US-style ticker.
  try {
    const r = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`);
    const j = (await r.json()) as { items?: Array<{ ticker?: string; name?: string }> };
    const hit = j.items?.[0];
    if (hit?.ticker) {
      return { symbol: hit.ticker, label: hit.name ?? hit.ticker, market: 'kr' };
    }
  } catch {
    /* fall through */
  }
  // US-style ticker fallback (e.g. SPY, AAPL).
  if (/^[A-Za-z]{1,5}$/.test(q)) {
    return { symbol: upper, label: upper, market: 'us' };
  }
  return null;
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
  // Compare overlay — user input free-text (한글 이름·티커·지수 모두 허용).
  // Resolved form drives both the chart fetch and the legend label.
  const [compareSymbol, setCompareSymbol] = useState<string>('');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareResolved, setCompareResolved] = useState<
    { symbol: string; label: string; market: 'kr' | 'us' } | null
  >(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  // Recent-compares dropdown — populated from localStorage on mount,
  // re-saved whenever a new compare is activated.
  const [recents, setRecents] = useState<RecentCompare[]>([]);
  const [recentsOpen, setRecentsOpen] = useState(false);

  // Mouse-Y tracker for the horizontal crosshair. Recharts 3.x
  // changed the internal architecture so `Customized` no longer
  // receives `yAxisMap`/`offset` in the shape older versions used —
  // forced us to drop the in-SVG approach. Instead we wrap the price
  // pane in a `relative` div, capture native mouse coordinates, and
  // render an absolutely-positioned overlay on top of the chart with
  // the horizontal line + price badge. This bypasses Recharts'
  // internal API entirely so it works regardless of version.
  const priceContainerRef = useRef<HTMLDivElement>(null);
  const [cursorY, setCursorY] = useState<number | null>(null);

  // Volume pane has its own independent crosshair tracker. Same DOM
  // overlay pattern as the price pane but the right-edge badge shows
  // the volume value at that Y (formatted via fmtVol, e.g. 184.8만).
  const volumeContainerRef = useRef<HTMLDivElement>(null);
  const [volumeCursorY, setVolumeCursorY] = useState<number | null>(null);

  // ── Resizable volume pane ──────────────────────────────────
  // Pros use a draggable divider between price and volume so they
  // can expand the volume area when they want more detail (volume
  // MA, OBV, up/down ratio) and collapse it when they just need a
  // glance. Height persisted to localStorage so user prefs survive
  // navigation. min/max bounded to keep the chart usable.
  const VOLUME_HEIGHT_KEY = 'chart:fs:volume-h';
  const VOLUME_MIN = 60;
  const VOLUME_MAX = 500;
  const [volumeHeight, setVolumeHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 110;
    try {
      const raw = window.localStorage.getItem(VOLUME_HEIGHT_KEY);
      const v = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(v) && v >= VOLUME_MIN && v <= VOLUME_MAX ? v : 110;
    } catch {
      return 110;
    }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(VOLUME_HEIGHT_KEY, String(volumeHeight));
    } catch {
      /* quota / disabled — silent */
    }
  }, [volumeHeight]);
  const [isDraggingVolume, setIsDraggingVolume] = useState(false);
  const volumeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  useEffect(() => {
    if (!isDraggingVolume) return;
    const onMove = (e: MouseEvent) => {
      if (!volumeDragRef.current) return;
      // Handle sits above the volume pane: dragging UP grows volume,
      // dragging DOWN shrinks it. delta is positive when moving down,
      // so subtract from start height.
      const delta = e.clientY - volumeDragRef.current.startY;
      const next = Math.max(
        VOLUME_MIN,
        Math.min(VOLUME_MAX, volumeDragRef.current.startHeight - delta),
      );
      setVolumeHeight(next);
    };
    const onUp = () => {
      setIsDraggingVolume(false);
      volumeDragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isDraggingVolume]);
  useEffect(() => {
    setRecents(loadRecents());
  }, []);

  // Resolve free-text input → chart-ready descriptor whenever the
  // user activates 비교 ON. Handles 한글 이름 via /api/stocks/search.
  useEffect(() => {
    if (!compareEnabled || !compareSymbol.trim()) {
      setCompareResolved(null);
      setCompareError(null);
      return;
    }
    let cancelled = false;
    setCompareError(null);
    void resolveCompare(compareSymbol).then((res) => {
      if (cancelled) return;
      if (!res) {
        setCompareResolved(null);
        setCompareError('종목을 찾을 수 없습니다');
        return;
      }
      setCompareResolved(res);
      // Push to recents (deduped, head-of-list, max 5).
      setRecents((prev) => {
        const next = [
          { symbol: res.symbol, label: res.label, market: res.market },
          ...prev.filter((r) => r.symbol !== res.symbol),
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
    // Show the 한글 label in the input so the user reads what they
    // picked; the resolution effect re-confirms but immediately
    // populating compareResolved avoids the search round-trip flash.
    setCompareSymbol(r.label);
    setCompareResolved({ symbol: r.symbol, label: r.label, market: r.market });
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

  // Compare chart fetch — keyed on the RESOLVED symbol/market, not the
  // raw input. This is how '삼성전자' (Korean name) ends up hitting
  // /api/kr-chart?ticker=005930 instead of being routed to us-chart.
  useEffect(() => {
    if (!compareEnabled || !compareResolved) {
      setCompareRaw([]);
      return;
    }
    let cancelled = false;
    const { symbol, market } = compareResolved;
    const url = market === 'kr'
      ? `/api/kr-chart?ticker=${encodeURIComponent(symbol)}&period=${apiPeriod}`
      : `/api/us-chart?symbol=${encodeURIComponent(symbol)}&period=${apiPeriod}`;
    fetch(url, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { candles?: RawCandle[]; error?: string }) => {
        if (cancelled) return;
        if (j.error) {
          setCompareError(`비교 데이터 로드 실패: ${j.error}`);
          setCompareRaw([]);
          return;
        }
        setCompareRaw(j.candles ?? []);
      })
      .catch(() => !cancelled && setCompareRaw([]));
    return () => { cancelled = true; };
  }, [compareEnabled, compareResolved, apiPeriod]);

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
    const volumesRaw = valid.map((c) => c.volume ?? 0);
    const ma5 = sma(closes, 5);
    const ma20 = sma(closes, 20);
    const ma60 = sma(closes, 60);
    const ma120 = sma(closes, 120);
    const { upper: bbU, lower: bbL } = bollinger(closes, 20, 2);
    const rsiSeries = rsi(closes, 14);
    // Volume MA20 — average volume baseline. Bars rising above this
    // line signal unusually heavy participation (breakout / capitulation).
    const volMa20Series = sma(volumesRaw, 20);
    // On-Balance Volume (OBV) — cumulative running total that adds
    // volume on up days and subtracts on down days. Divergence between
    // OBV and price is one of the oldest accumulation/distribution
    // signals (Granville, 1963).
    const obvSeries: number[] = new Array(valid.length).fill(0);
    let obvAcc = 0;
    for (let i = 0; i < valid.length; i++) {
      if (i > 0) {
        if (valid[i].close > valid[i - 1].close) obvAcc += volumesRaw[i];
        else if (valid[i].close < valid[i - 1].close) obvAcc -= volumesRaw[i];
      }
      obvSeries[i] = obvAcc;
    }

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
        volMa20: volMa20Series[i],
        obv: obvSeries[i],
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
  // Max single-bar volume in the window — powers the volume-pane
  // crosshair's Y→volume inversion. Recharts pads 'auto' domain by
  // ~5%, so we mirror that when computing the value at the cursor.
  const periodVolumeMax = useMemo(
    () => (data.length === 0
      ? null
      : Math.max(...data.map((d) => (Number.isFinite(d.volume) ? d.volume : 0)))),
    [data],
  );

  // ── Volume-pane statistics (powers the progressive disclosure) ──
  // Computed once per data change. Fields used at each tier:
  //   tier 0 (height ≥ 90):  avg, relativeVol (last vs avg)
  //   tier 1 (height ≥ 150): + upPct / downPct (매수/매도 비율)
  //   tier 2 (height ≥ 220): + OBV trend (compute Δ over window)
  const volumeStats = useMemo(() => {
    if (data.length === 0) return null;
    const vols = data.map((d) => d.volume).filter((v) => Number.isFinite(v) && v > 0);
    if (vols.length === 0) return null;
    const total = vols.reduce((a, b) => a + b, 0);
    const avg = total / vols.length;
    const lastV = data[data.length - 1].volume;
    const relativeVol = avg > 0 ? lastV / avg : 0;
    let upVol = 0;
    let downVol = 0;
    for (const d of data) {
      if (d.isUp) upVol += d.volume;
      else downVol += d.volume;
    }
    const upTotal = upVol + downVol;
    const upPct = upTotal > 0 ? (upVol / upTotal) * 100 : 50;
    // OBV change over window — positive = accumulation, negative = distribution.
    const obvDelta = data[data.length - 1].obv - data[0].obv;
    return { total, avg, lastV, relativeVol, upVol, downVol, upPct, obvDelta };
  }, [data]);

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
  // priceHeight is the height of the price PANE. volumeHeight comes
  // from the resizable state declared above — user can drag the
  // divider between price & volume to expand the volume area.
  const priceHeight = showRsi && showVolume ? 480 : showRsi || showVolume ? 540 : 620;
  const rsiHeight = 110;
  // L/XL volume pane adds an OBV YAxis on the LEFT (width 56). Without
  // matching margin on the other panes, the volume pane's inner plot
  // area starts 56px further right than the price/RSI panes — so the
  // syncId vertical crosshair lands at different X coordinates between
  // panes for the same data index. Bumping every pane's left margin
  // to the same value when OBV is active keeps all inner-area ranges
  // aligned, which is what syncId actually needs to line up cursors.
  const obvAxisShown = showVolume && volumeHeight >= 220;
  const sharedLeftMargin = obvAxisShown ? 64 : 8;

  const compareLabel = compareEnabled && compareResolved
    ? compareResolved.label
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
          {compareEnabled && compareLabel && !compareError && (
            <span className="text-[10px] text-status-info font-medium">
              vs {compareLabel}
              {compareResolved && compareResolved.label !== compareResolved.symbol && (
                <span className="text-txt-muted font-mono ml-1">
                  ({compareResolved.symbol})
                </span>
              )}
            </span>
          )}
          {compareEnabled && compareError && (
            <span className="text-[10px] text-status-danger font-medium" title={compareError}>
              ⚠ {compareError}
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
          {/* Price pane — wrapped in a `relative` div so we can paint
              a DOM crosshair overlay on top regardless of Recharts'
              internal API. */}
          <div
            ref={priceContainerRef}
            className="relative"
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const y = e.clientY - rect.top;
              if (Number.isFinite(y) && y >= 0 && y <= rect.height) {
                setCursorY(y);
              }
            }}
            onMouseLeave={() => setCursorY(null)}
          >
          <ResponsiveContainer width="100%" height={priceHeight}>
            <ComposedChart
              data={data}
              syncId="fs-chart"
              margin={{ top: 12, right: 64, bottom: 0, left: sharedLeftMargin }}
            >
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

          {/* DOM-level crosshair overlay — positioned absolutely on top
              of the price chart. Uses native mouse coordinates so it
              works regardless of Recharts version internals. Price is
              computed from periodHigh/Low + the chart's known margin
              (top: 12, bottom: 0). Line spans the plot area, label
              sits flush against the right Y-axis. */}
          {cursorY != null && periodHigh != null && periodLow != null && (() => {
            const MARGIN_TOP = 12;
            const MARGIN_RIGHT = 64;
            // Match the chart's dynamic margin.left so the horizontal
            // crosshair line starts exactly at the inner plot edge,
            // not 56px to the left of it when OBV axis is active.
            const MARGIN_LEFT = sharedLeftMargin;
            const containerH = priceContainerRef.current?.clientHeight ?? priceHeight;
            const containerW = priceContainerRef.current?.clientWidth ?? 0;
            const innerH = containerH - MARGIN_TOP;        // bottom margin is 0
            if (innerH <= 0) return null;
            // Don't render when cursor is in the margin band.
            if (cursorY < MARGIN_TOP - 2 || cursorY > containerH) return null;
            const ratio = Math.max(0, Math.min(1, (cursorY - MARGIN_TOP) / innerH));
            // Mirror Recharts' default 'auto' domain padding (~5%).
            const pad = (periodHigh - periodLow) * 0.05;
            const yMax = periodHigh + pad;
            const yMin = Math.max(0, periodLow - pad);
            const rawPrice = yMax - ratio * (yMax - yMin);
            // Snap the displayed price to the nearest 100원 for KR
            // charts — KR prices trade in 100원 ticks at low-to-mid
            // values, so showing 34,567 implied false precision. US
            // charts keep their existing $XX.XX formatting.
            const price = variant === 'kr'
              ? Math.round(rawPrice / 100) * 100
              : rawPrice;
            const text = fmt(price);
            return (
              <div
                className="pointer-events-none absolute inset-0"
                aria-hidden
              >
                {/* Horizontal dashed line (fainter than the vertical) */}
                <div
                  className="absolute"
                  style={{
                    top: cursorY,
                    left: MARGIN_LEFT,
                    right: MARGIN_RIGHT,
                    height: 0,
                    borderTop: '1px dashed rgba(114,60,235,0.5)',
                  }}
                />
                {/* Price badge flush against the right Y-axis */}
                <div
                  className="absolute font-mono font-bold tabular-nums"
                  style={{
                    top: cursorY - 9,
                    right: 0,
                    minWidth: 72,
                    height: 18,
                    padding: '0 8px',
                    lineHeight: '18px',
                    fontSize: 11,
                    color: '#FFFFFF',
                    background: 'rgba(114,60,235,0.96)',
                    borderRadius: 3,
                    textAlign: 'center',
                  }}
                >
                  {text}
                </div>
              </div>
            );
          })()}
          </div>

          {/* Volume pane — resizable via drag handle above. Renders
              progressively richer content as the pane grows:
                ≥ 90px:  bars + stats badge (평균/상대 거래량)
                ≥ 150px: + Volume MA(20) overlay + 매수/매도 비율
                ≥ 220px: + OBV (On-Balance Volume) trend line
              This mirrors the pattern in TradingView / Bloomberg
              where each pane has an independent resize handle. */}
          {showVolume && (
            <>
              {/* Drag handle — sits between price and volume panes */}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-valuenow={volumeHeight}
                aria-valuemin={VOLUME_MIN}
                aria-valuemax={VOLUME_MAX}
                aria-label="거래량 페인 높이 조절"
                title="드래그하여 거래량 페인 높이 조절 (위로: 확장, 아래로: 축소)"
                onMouseDown={(e) => {
                  e.preventDefault();
                  volumeDragRef.current = {
                    startY: e.clientY,
                    startHeight: volumeHeight,
                  };
                  setIsDraggingVolume(true);
                }}
                onDoubleClick={() => setVolumeHeight(110)}      // reset to default
                className={cn(
                  'group relative h-2 -my-px cursor-ns-resize z-10 select-none',
                  'flex items-center justify-center',
                  'transition-colors',
                  isDraggingVolume && 'bg-brand-purple/15',
                )}
              >
                {/* Subtle separator line + grip dots that appear on hover */}
                <div
                  className={cn(
                    'absolute inset-x-0 top-1/2 -translate-y-1/2 h-px',
                    'bg-border-subtle/50 group-hover:bg-brand-purple/60',
                    isDraggingVolume && 'bg-brand-purple h-0.5',
                    'transition-all',
                  )}
                />
                <div
                  className={cn(
                    'relative flex items-center gap-0.5 px-2 py-0.5 rounded-md',
                    'bg-bg-secondary/90 border border-border-subtle/40',
                    'opacity-0 group-hover:opacity-100 transition-opacity',
                    isDraggingVolume && 'opacity-100 border-brand-purple/50',
                  )}
                >
                  <span className="block w-0.5 h-0.5 rounded-full bg-txt-muted" />
                  <span className="block w-0.5 h-0.5 rounded-full bg-txt-muted" />
                  <span className="block w-0.5 h-0.5 rounded-full bg-txt-muted" />
                </div>
              </div>

              {/* Volume container — `group` so the tier-selector
                  appears only on hover; `relative` so overlays
                  position correctly. Native onMouseMove captures the
                  Y for the volume-pane horizontal crosshair. */}
              <div
                ref={volumeContainerRef}
                className="relative group"
                onMouseMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const y = e.clientY - rect.top;
                  if (Number.isFinite(y) && y >= 0 && y <= rect.height) {
                    setVolumeCursorY(y);
                  }
                }}
                onMouseLeave={() => setVolumeCursorY(null)}
              >
                {/* Quick-resize tier selector — appears at top-center
                    on hover. Click any tier to jump straight to that
                    size; for fine tuning the drag handle above still
                    works. The currently-active tier (the one closest
                    to volumeHeight) is highlighted in brand purple. */}
                <div
                  className={cn(
                    'absolute top-1 left-1/2 -translate-x-1/2 z-20',
                    'opacity-0 group-hover:opacity-100 transition-opacity duration-150',
                    'flex items-center gap-0.5 px-1 py-0.5 rounded-md',
                    'bg-bg-secondary/95 backdrop-blur-sm',
                    'border border-border-default/60 shadow-md',
                  )}
                  role="group"
                  aria-label="거래량 페인 크기"
                >
                  {VOLUME_TIERS.map((t) => {
                    // Active = the tier with smallest absolute distance.
                    const distances = VOLUME_TIERS.map((tt) =>
                      Math.abs(volumeHeight - tt.value),
                    );
                    const minIdx = distances.indexOf(Math.min(...distances));
                    const isActive = VOLUME_TIERS[minIdx].id === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setVolumeHeight(t.value)}
                        title={t.title}
                        aria-pressed={isActive}
                        className={cn(
                          'px-2.5 py-0.5 text-[10px] font-semibold rounded transition-colors',
                          isActive
                            ? 'bg-brand-purple text-white shadow-sm'
                            : 'text-txt-secondary hover:text-txt-primary hover:bg-bg-tertiary/60',
                        )}
                      >
                        {t.id}
                      </button>
                    );
                  })}
                </div>

                {/* Stats overlay (progressive disclosure) */}
                {volumeStats && volumeHeight >= 90 && (
                  <div className="pointer-events-none absolute top-1 left-2 z-10 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[10px]">
                    <span className="text-txt-muted">
                      평균 거래량{' '}
                      <span className="font-mono text-txt-primary tabular-nums">
                        {fmtVol(volumeStats.avg)}
                      </span>
                    </span>
                    <span className="text-txt-muted">
                      상대{' '}
                      <span
                        className="font-mono font-semibold tabular-nums"
                        style={{
                          color:
                            volumeStats.relativeVol >= 1.5
                              ? '#F26D6D'   // 평소 1.5배 이상 = 강세
                              : volumeStats.relativeVol >= 1.0
                                ? 'var(--text-primary)'
                                : 'var(--text-muted)',
                        }}
                        title="당일 거래량 / 기간 평균. 1.5배 이상이면 이례적 거래"
                      >
                        {volumeStats.relativeVol.toFixed(2)}x
                      </span>
                    </span>
                    {volumeHeight >= 150 && (
                      <>
                        <span className="text-txt-muted">
                          매수{' '}
                          <span
                            className="font-mono font-semibold tabular-nums"
                            style={{ color: upColor }}
                            title="기간 내 상승일의 거래량 합 비율"
                          >
                            {volumeStats.upPct.toFixed(0)}%
                          </span>
                        </span>
                        <span className="text-txt-muted">
                          매도{' '}
                          <span
                            className="font-mono font-semibold tabular-nums"
                            style={{ color: downColor }}
                          >
                            {(100 - volumeStats.upPct).toFixed(0)}%
                          </span>
                        </span>
                      </>
                    )}
                    {volumeHeight >= 220 && (
                      <span className="text-txt-muted">
                        OBV Δ{' '}
                        <span
                          className="font-mono font-semibold tabular-nums"
                          style={{
                            color: volumeStats.obvDelta >= 0 ? upColor : downColor,
                          }}
                          title="기간 OBV 변화량. 양수=매집(상승 거래량 우세), 음수=분배"
                        >
                          {volumeStats.obvDelta >= 0 ? '+' : ''}
                          {fmtVol(volumeStats.obvDelta)}
                        </span>
                      </span>
                    )}
                  </div>
                )}

                {/* MA20 / OBV legend bar — only shows when those overlays render */}
                {(volumeHeight >= 150 || volumeHeight >= 220) && (
                  <div className="pointer-events-none absolute top-1 right-16 z-10 flex items-center gap-3 text-[9px]">
                    {volumeHeight >= 150 && (
                      <span className="flex items-center gap-1 text-txt-muted">
                        <span className="inline-block w-3 h-0.5" style={{ background: '#FFA94D' }} />
                        Volume MA20
                      </span>
                    )}
                    {volumeHeight >= 220 && (
                      <span className="flex items-center gap-1 text-txt-muted">
                        <span className="inline-block w-3 h-0.5" style={{ background: '#A855F7' }} />
                        OBV
                      </span>
                    )}
                  </div>
                )}

                <ResponsiveContainer width="100%" height={volumeHeight}>
                  <ComposedChart
                    data={data}
                    syncId="fs-chart"
                    // When OBV axis is active (L/XL), the left YAxis
                    // consumes 56px from the chart's left edge. We set
                    // margin.left=8 here because the OBV YAxis below
                    // already reserves its own 56px; total left
                    // consumption = 8 + 56 = 64 which matches the
                    // other panes' sharedLeftMargin.
                    margin={{
                      top: volumeStats && volumeHeight >= 90 ? 22 : 4,
                      right: 64,
                      bottom: 4,
                      left: obvAxisShown ? 8 : sharedLeftMargin,
                    }}
                  >
                    <CartesianGrid stroke="var(--border-subtle)" strokeOpacity="0.3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--txt-muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={50} ticks={intradayTicks} tickFormatter={xTickFormatter} hide={showRsi} />
                    <YAxis yAxisId="volume" domain={[0, 'auto']} tick={{ fontSize: 9, fill: 'var(--txt-muted)' }} axisLine={false} tickLine={false} width={64} orientation="right" tickFormatter={(v) => fmtVol(Number(v))} tickCount={3} />
                    {/* Secondary axis for OBV — appears only when its
                        overlay is drawn, on the LEFT to not crowd the
                        volume Y axis on the right. */}
                    {volumeHeight >= 220 && (
                      <YAxis
                        yAxisId="obv"
                        orientation="left"
                        width={56}
                        domain={['auto', 'auto']}
                        tick={{ fontSize: 9, fill: '#A855F7' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => fmtVol(Number(v))}
                        tickCount={3}
                      />
                    )}
                    <Tooltip cursor={CROSSHAIR_CURSOR} content={() => null} />
                    <Bar
                      yAxisId="volume"
                      dataKey="volume"
                      shape={(props: unknown) => (
                        <VolumeShape {...(props as VolumeShapeProps)} upColor={upColor} downColor={downColor} />
                      )}
                      isAnimationActive={false}
                    />
                    {/* Volume MA20 — only when pane is tall enough */}
                    {volumeHeight >= 150 && (
                      <Line
                        yAxisId="volume"
                        type="monotone"
                        dataKey="volMa20"
                        stroke="#FFA94D"
                        strokeWidth={1.3}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    )}
                    {/* OBV — accumulation/distribution running total */}
                    {volumeHeight >= 220 && (
                      <Line
                        yAxisId="obv"
                        type="monotone"
                        dataKey="obv"
                        stroke="#A855F7"
                        strokeWidth={1.3}
                        dot={false}
                        isAnimationActive={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>

                {/* Volume-pane horizontal crosshair — DOM overlay
                    mirroring the price pane's pattern. Right-edge pill
                    shows the volume value at the cursor (formatted via
                    fmtVol so big numbers come out as '184.8만' /
                    '1.2억' instead of raw digits). */}
                {volumeCursorY != null && periodVolumeMax != null && (() => {
                  const MARGIN_TOP = volumeStats && volumeHeight >= 90 ? 22 : 4;
                  const MARGIN_BOTTOM = 4;
                  const MARGIN_RIGHT = 64;
                  // Total left consumption (margin + optional OBV YAxis) —
                  // see sharedLeftMargin notes above. Either S/M (no OBV,
                  // margin.left = sharedLeftMargin) or L/XL (margin.left = 8,
                  // OBV YAxis width = 56) sums to the same number.
                  const MARGIN_LEFT = sharedLeftMargin;
                  const containerH = volumeContainerRef.current?.clientHeight ?? volumeHeight;
                  const innerTop = MARGIN_TOP;
                  const innerBottom = containerH - MARGIN_BOTTOM;
                  const innerH = innerBottom - innerTop;
                  if (innerH <= 0) return null;
                  if (volumeCursorY < innerTop - 2 || volumeCursorY > innerBottom + 2) return null;
                  const ratio = Math.max(0, Math.min(1, (volumeCursorY - innerTop) / innerH));
                  // Volume axis: 0 at bottom, max (+5% pad) at top.
                  const yMax = periodVolumeMax * 1.05;
                  const volumeVal = Math.max(0, yMax * (1 - ratio));
                  const text = fmtVol(volumeVal);
                  return (
                    <div className="pointer-events-none absolute inset-0" aria-hidden>
                      <div
                        className="absolute"
                        style={{
                          top: volumeCursorY,
                          left: MARGIN_LEFT,
                          right: MARGIN_RIGHT,
                          height: 0,
                          borderTop: '1px dashed rgba(114,60,235,0.5)',
                        }}
                      />
                      <div
                        className="absolute font-mono font-bold tabular-nums"
                        style={{
                          top: volumeCursorY - 8,
                          right: 0,
                          minWidth: 56,
                          height: 16,
                          padding: '0 6px',
                          lineHeight: '16px',
                          fontSize: 10,
                          color: '#FFFFFF',
                          background: 'rgba(114,60,235,0.96)',
                          borderRadius: 3,
                          textAlign: 'center',
                        }}
                      >
                        {text}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </>
          )}

          {/* RSI pane */}
          {showRsi && (
            <ResponsiveContainer width="100%" height={rsiHeight}>
              <ComposedChart data={data} syncId="fs-chart" margin={{ top: 4, right: 64, bottom: 8, left: sharedLeftMargin }}>
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
