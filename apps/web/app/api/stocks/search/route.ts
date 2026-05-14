/**
 * Server-side proxy for NAVER's stock autocomplete (`ac.stock.naver.com`).
 * Browsers can't call NAVER directly due to CORS, so we mirror it here for
 * the LNB favorites picker and any future search UI that needs broader
 * coverage than our local `stocks` master.
 *
 * Returns `{items: [{ticker, name, market}]}`.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

interface NaverAcItem {
  code: string;
  name: string;
  typeCode: string;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  if (q.length === 0) return NextResponse.json({ items: [] });

  try {
    // The legacy `ac.stock.naver.com` endpoint only covers KOSPI/KOSDAQ and
    // misses some ETFs. The modern mobile front-api includes ETF + index +
    // crypto, so we hit it first and fall back to the legacy one on failure.
    let items: NaverAcItem[] = [];
    try {
      const modern = await fetch(
        `https://m.stock.naver.com/front-api/v1/search/autoComplete?query=${encodeURIComponent(q)}&target=stock,etf,etn`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            Accept: 'application/json',
          },
          cache: 'no-store',
        },
      );
      if (modern.ok) {
        const mj = (await modern.json()) as {
          result?: { items?: Array<{ code?: string; name?: string; typeName?: string; nationCode?: string }> };
        };
        items = (mj.result?.items ?? [])
          .filter((it) => it.code && /^\d{6}$/.test(it.code) && it.nationCode === 'KOR')
          .map((it) => ({
            code: it.code as string,
            name: it.name ?? '',
            typeCode: it.typeName ?? '',
          }));
      }
    } catch {
      /* fall through to legacy */
    }

    if (items.length === 0) {
      const res = await fetch(
        `https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            Accept: 'application/json',
          },
          cache: 'no-store',
        },
      );
      if (!res.ok) return NextResponse.json({ items: [] });
      const j = (await res.json()) as { items?: NaverAcItem[] };
      items = j.items ?? [];
    }

    const j = { items };
    // Accept any 6-char alphanumeric ticker. Newer ETFs use codes with a
    // letter in them (e.g. 0167A0 for SOL AI반도체TOP2플러스).
    const out = (j.items ?? [])
      .filter((it) => /^[0-9A-Z]{6}$/i.test(it.code))
      .slice(0, 20)
      .map((it) => ({
        ticker: it.code,
        name: it.name,
        market: it.typeCode,
      }));
    return NextResponse.json({ items: out });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
