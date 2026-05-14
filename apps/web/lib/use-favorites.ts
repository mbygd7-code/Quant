'use client';

/**
 * Personal favorites hook — backs the LNB 관심주식 list and the ★ toggle
 * on /watchlist rows.
 *
 * Two components used to reimplement this independently (sidebar.tsx +
 * watchlist-table.tsx) with the same StrictMode-double-invocation
 * workaround and the same cross-tab + same-tab broadcast trick. Audit
 * High #3 — factored here.
 *
 * Contract:
 *   - `tickers` is the ordered list (insertion order preserved).
 *   - `add` / `remove` are stable references; safe to use in deps.
 *   - Writes localStorage immediately and broadcasts a `storage` event so
 *     every other consumer (Sidebar ↔ WatchlistTable) updates in lockstep.
 *   - Side effects live OUTSIDE the setState updater — React strict mode
 *     would otherwise run updaters twice and toggle the value back.
 */
import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'qs:favorites:v1';

function readStorage(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

function writeAndBroadcast(next: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    // Native `storage` event only fires cross-tab; dispatch one manually
    // so other hook instances in this tab update too.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: STORAGE_KEY,
        newValue: JSON.stringify(next),
      }),
    );
  } catch {
    /* quota exceeded or unavailable — silent */
  }
}

export interface UseFavoritesResult {
  tickers: string[];
  has: (ticker: string) => boolean;
  add: (ticker: string) => void;
  remove: (ticker: string) => void;
  toggle: (ticker: string) => boolean; // returns final membership state
  hydrated: boolean;
}

export function useFavorites(): UseFavoritesResult {
  const [tickers, setTickers] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTickers(readStorage());
    setHydrated(true);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      try {
        setTickers(JSON.parse(e.newValue ?? '[]') as string[]);
      } catch {
        setTickers([]);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const add = useCallback((ticker: string) => {
    const prev = readStorage();
    if (prev.includes(ticker)) return;
    const next = [...prev, ticker];
    writeAndBroadcast(next);
    setTickers(next);
  }, []);

  const remove = useCallback((ticker: string) => {
    const prev = readStorage();
    const next = prev.filter((t) => t !== ticker);
    writeAndBroadcast(next);
    setTickers(next);
  }, []);

  const toggle = useCallback((ticker: string): boolean => {
    const prev = readStorage();
    const wasIn = prev.includes(ticker);
    const next = wasIn ? prev.filter((t) => t !== ticker) : [...prev, ticker];
    writeAndBroadcast(next);
    setTickers(next);
    return !wasIn;
  }, []);

  const has = useCallback(
    (ticker: string) => tickers.includes(ticker),
    [tickers],
  );

  return { tickers, has, add, remove, toggle, hydrated };
}
