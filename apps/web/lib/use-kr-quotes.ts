'use client';

import { useEffect, useState } from 'react';

export interface KrLiveQuote {
  ticker: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  marketStatus: string | null;  // "OPEN" | "CLOSE" | ...
  tradedAt: string | null;
}

/**
 * Bulk-fetch NAVER quotes for the given KR 6-digit tickers and return a
 * Map keyed by ticker. Re-fetches whenever the ticker set changes; one
 * round-trip per change (no auto-polling — wire up an interval at the
 * call site if you want one).
 */
export function useKrQuotes(tickers: string[]): {
  quotes: Map<string, KrLiveQuote>;
  loading: boolean;
} {
  const [quotes, setQuotes] = useState<Map<string, KrLiveQuote>>(new Map());
  const [loading, setLoading] = useState(false);

  // Stable cache key — sorted to avoid re-fetch on order changes
  const key = [...tickers].sort().join(',');

  useEffect(() => {
    if (tickers.length === 0) {
      setQuotes(new Map());
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/kr-quotes?tickers=${encodeURIComponent(tickers.join(','))}`, {
      cache: 'no-store',
    })
      .then((r) => r.json())
      .then((j: { results?: Array<KrLiveQuote & { ok: boolean }> }) => {
        if (cancelled) return;
        const map = new Map<string, KrLiveQuote>();
        for (const r of j.results ?? []) {
          if (r.ok) {
            map.set(r.ticker, {
              ticker: r.ticker,
              price: r.price ?? null,
              change: r.change ?? null,
              changeRate: r.changeRate ?? null,
              marketStatus: r.marketStatus ?? null,
              tradedAt: r.tradedAt ?? null,
            });
          }
        }
        setQuotes(map);
      })
      .catch(() => {
        if (cancelled) return;
        setQuotes(new Map());
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { quotes, loading };
}
