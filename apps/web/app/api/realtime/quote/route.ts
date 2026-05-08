import { NextRequest, NextResponse } from 'next/server';
import { AvError, getGlobalQuote } from '@/lib/alphavantage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const symbols = (req.nextUrl.searchParams.get('symbols') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5); // hard cap (free tier 5/min)

  if (symbols.length === 0) {
    return NextResponse.json({ error: 'symbols= required' }, { status: 400 });
  }

  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const q = await getGlobalQuote(symbol);
        return { ok: true as const, ...q };
      } catch (e) {
        const code = e instanceof AvError ? e.code : 'UPSTREAM';
        const message = e instanceof Error ? e.message : 'unknown';
        return { ok: false as const, symbol, code, message };
      }
    }),
  );

  return NextResponse.json({
    fetchedAt: new Date().toISOString(),
    results,
  });
}
