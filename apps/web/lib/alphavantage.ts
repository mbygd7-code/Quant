/**
 * Alpha Vantage server-side client (Next.js Route Handlers only).
 *
 * Free tier: 25 calls/day, 5 calls/minute. Per CLAUDE.md §I, MCP/SDK is for
 * ad-hoc analysis only — never wire this into batch pipelines.
 *
 * KEEP THIS FILE SERVER-ONLY. Never import from a 'use client' component.
 */
import 'server-only';

const BASE = 'https://www.alphavantage.co/query';

export interface AvQuote {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  latestTradingDay: string | null;
}

export interface AvIntradayBar {
  t: string;       // ISO timestamp (exchange-local)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class AvError extends Error {
  constructor(message: string, public code: 'NO_KEY' | 'RATE_LIMIT' | 'BAD_SYMBOL' | 'UPSTREAM') {
    super(message);
  }
}

function getKey(): string {
  const k = process.env.ALPHA_VANTAGE_KEY;
  if (!k) throw new AvError('ALPHA_VANTAGE_KEY not configured', 'NO_KEY');
  return k;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace('%', ''));
  return Number.isFinite(n) ? n : null;
}

async function avFetch(params: Record<string, string>): Promise<Record<string, unknown>> {
  const apikey = getKey();
  const url = new URL(BASE);
  for (const [k, v] of Object.entries({ ...params, apikey })) url.searchParams.set(k, v);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new AvError(`upstream ${res.status}`, 'UPSTREAM');
  const json = (await res.json()) as Record<string, unknown>;
  const note = (json['Note'] ?? json['Information']) as string | undefined;
  if (note && /thank you|frequency|rate/i.test(note)) {
    throw new AvError(note, 'RATE_LIMIT');
  }
  if (json['Error Message']) {
    throw new AvError(String(json['Error Message']), 'BAD_SYMBOL');
  }
  return json;
}

/**
 * Normalize a user-facing ticker.
 *  - 6-digit KR ticker → "005930.KRX" (Alpha Vantage's KRX suffix)
 *  - already-suffixed (BHP.AX, 7203.T) → as-is
 *  - US ticker (AAPL) → as-is
 */
export function normalizeSymbol(input: string): string {
  const t = input.trim().toUpperCase();
  if (/^\d{6}$/.test(t)) return `${t}.KRX`;
  return t;
}

export async function getGlobalQuote(symbol: string): Promise<AvQuote> {
  const json = await avFetch({ function: 'GLOBAL_QUOTE', symbol: normalizeSymbol(symbol) });
  const q = (json['Global Quote'] ?? {}) as Record<string, string>;
  return {
    symbol,
    price: num(q['05. price']),
    change: num(q['09. change']),
    changePercent: num(q['10. change percent']),
    open: num(q['02. open']),
    high: num(q['03. high']),
    low: num(q['04. low']),
    prevClose: num(q['08. previous close']),
    volume: num(q['06. volume']),
    latestTradingDay: q['07. latest trading day'] ?? null,
  };
}

/**
 * Intraday bars (5min default) — newest first.
 * Free tier supports 1min/5min/15min/30min/60min on US tickers.
 */
export async function getIntraday(
  symbol: string,
  interval: '1min' | '5min' | '15min' | '30min' | '60min' = '5min',
  outputsize: 'compact' | 'full' = 'compact',
): Promise<AvIntradayBar[]> {
  const json = await avFetch({
    function: 'TIME_SERIES_INTRADAY',
    symbol: normalizeSymbol(symbol),
    interval,
    outputsize,
  });
  const key = `Time Series (${interval})`;
  const series = (json[key] ?? {}) as Record<string, Record<string, string>>;
  return Object.entries(series)
    .map(([t, row]) => ({
      t,
      open: Number(row['1. open']),
      high: Number(row['2. high']),
      low: Number(row['3. low']),
      close: Number(row['4. close']),
      volume: Number(row['5. volume']),
    }))
    .filter((b) => Number.isFinite(b.close))
    .sort((a, b) => (a.t < b.t ? 1 : -1));
}
