import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Yahoo Finance chart proxy for US tickers. Free, no auth. Used by
 * the realtime monitor's expand-card chart. Resolutions:
 *   - daily (default): range=3mo, interval=1d
 *   - intraday:        range=1d,  interval=5m
 */
const ENDPOINT = 'https://query1.finance.yahoo.com/v8/finance/chart';

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

type Period = '1d' | '1w' | '1m' | '3m' | '1y' | 'daily' | 'intraday';

const RANGE_MAP: Record<Period, string> = {
  '1d': 'range=1d&interval=5m',
  '1w': 'range=5d&interval=15m',
  '1m': 'range=1mo&interval=1d',
  '3m': 'range=3mo&interval=1d',
  '1y': 'range=1y&interval=1d',
  daily: 'range=3mo&interval=1d',     // legacy
  intraday: 'range=1d&interval=5m',   // legacy
};

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').trim().toUpperCase();
  const period = (req.nextUrl.searchParams.get('period') ?? '3m') as Period;
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol= required' }, { status: 400 });
  }
  const params = RANGE_MAP[period] ?? RANGE_MAP['3m'];
  const url = `${ENDPOINT}/${encodeURIComponent(symbol)}?${params}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `yahoo ${res.status}` }, { status: 502 });
    }
    const j = (await res.json()) as YahooChart;
    const r = j.chart?.result?.[0];
    if (!r || !r.timestamp || !r.indicators?.quote?.[0]) {
      return NextResponse.json({ symbol, candles: [] });
    }
    const ts = r.timestamp;
    const q = r.indicators.quote[0];
    const candles: Array<{ t: number; open: number; high: number; low: number; close: number; volume: number }> = [];
    for (let i = 0; i < ts.length; i++) {
      const close = q.close?.[i];
      if (close == null || !Number.isFinite(close)) continue;
      candles.push({
        t: ts[i] * 1000,
        open: q.open?.[i] ?? close,
        high: q.high?.[i] ?? close,
        low: q.low?.[i] ?? close,
        close,
        volume: q.volume?.[i] ?? 0,
      });
    }
    return NextResponse.json(
      { symbol, period, candles },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'fetch failed' },
      { status: 500 },
    );
  }
}
