import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Finnhub global symbol search proxy. Lets the realtime monitor look
 * up any US-tradeable ticker by name (e.g. "amd", "berkshire", "ETF").
 * Free tier supports this endpoint at 60 calls/min.
 */
const ENDPOINT = 'https://finnhub.io/api/v1/search';

interface FhSearchHit {
  description: string;
  displaySymbol: string;
  symbol: string;
  type: string;
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim();
  if (q.length === 0) {
    return NextResponse.json({ results: [] });
  }
  const token = process.env.FINNHUB_API_KEY ?? process.env.NEXT_PUBLIC_FINNHUB_KEY;
  if (!token) {
    return NextResponse.json({ error: 'finnhub key missing' }, { status: 500 });
  }
  const url = `${ENDPOINT}?q=${encodeURIComponent(q)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    return NextResponse.json({ error: `finnhub ${res.status}` }, { status: 502 });
  }
  const j = (await res.json()) as { count?: number; result?: FhSearchHit[] };
  // Filter to US-listed names: WS streaming on free tier is IEX (US),
  // and non-US symbols carry an exchange suffix (e.g. "TSLA.MX").
  const results = (j.result ?? [])
    .filter((r) => /^[A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z])?$/.test(r.symbol))
    // ^ keeps "AAPL", "BRK.A", "BRK-B"; rejects foreign suffixes like
    //   "TSLA.MX", "HSBA.L", "9988.HK" (2+ chars after dot, or digits-only).
    .filter((r) => r.type === 'Common Stock' || r.type === 'ETP' || r.type === 'ETF')
    .slice(0, 20)
    .map((r) => ({
      symbol: r.displaySymbol || r.symbol,
      name: r.description,
      type: r.type,
    }));
  return NextResponse.json({ q, results });
}
