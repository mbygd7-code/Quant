'use client';

/**
 * Personal favorites hook — backs the LNB 관심주식 list and the ★ toggle
 * on /watchlist rows.
 *
 * Two-tier persistence:
 *   1. localStorage  → instant UX, no network round-trip on toggle.
 *   2. user_favorites table  → server-side mirror so the M4 cycle worker
 *      knows which tickers to spend LLM budget on (Stage-2 analysis).
 *
 * The two are eventually consistent — a localStorage write that hasn't
 * propagated to the server yet just delays inclusion in the next cron.
 *
 * Side effects (write, broadcast, network) live OUTSIDE the setState
 * updater since React strict mode would otherwise toggle them twice.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  addFavoriteAction,
  removeFavoriteAction,
  syncFavoritesAction,
} from '@/app/actions/favorites';

const STORAGE_KEY = 'qs:favorites:v1';
const SYNCED_KEY  = 'qs:favorites:synced-at';
const SYNC_THROTTLE_MS = 30_000; // don't bulk-sync more than 1×/30s

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
    const initial = readStorage();
    setTickers(initial);
    setHydrated(true);

    // One-shot bulk sync on mount — handles the case where the user added
    // favorites offline / on another device and the localStorage layer is
    // ahead of the server. Throttled so we don't hammer it on every page
    // navigation.
    try {
      const lastSync = Number(localStorage.getItem(SYNCED_KEY) ?? '0');
      if (Date.now() - lastSync > SYNC_THROTTLE_MS) {
        void syncFavoritesAction(initial).then((res) => {
          if ('ok' in res && res.ok) {
            try {
              localStorage.setItem(SYNCED_KEY, String(Date.now()));
            } catch {}
          }
        });
      }
    } catch {
      /* localStorage unavailable — skip server sync this turn */
    }

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

  // Fire-and-forget server mirror. If the network call fails we silently
  // retry on the next mount's bulk-sync; UI never blocks on it.
  const mirrorToServer = useCallback((op: 'add' | 'remove', ticker: string) => {
    const fn = op === 'add' ? addFavoriteAction : removeFavoriteAction;
    void fn(ticker).catch(() => {
      /* swallow — next mount's bulk sync will reconcile */
    });
  }, []);

  const add = useCallback(
    (ticker: string) => {
      const prev = readStorage();
      if (prev.includes(ticker)) return;
      const next = [...prev, ticker];
      writeAndBroadcast(next);
      setTickers(next);
      mirrorToServer('add', ticker);
    },
    [mirrorToServer],
  );

  const remove = useCallback(
    (ticker: string) => {
      const prev = readStorage();
      const next = prev.filter((t) => t !== ticker);
      writeAndBroadcast(next);
      setTickers(next);
      mirrorToServer('remove', ticker);
    },
    [mirrorToServer],
  );

  const toggle = useCallback(
    (ticker: string): boolean => {
      const prev = readStorage();
      const wasIn = prev.includes(ticker);
      const next = wasIn ? prev.filter((t) => t !== ticker) : [...prev, ticker];
      writeAndBroadcast(next);
      setTickers(next);
      mirrorToServer(wasIn ? 'remove' : 'add', ticker);
      return !wasIn;
    },
    [mirrorToServer],
  );

  const has = useCallback(
    (ticker: string) => tickers.includes(ticker),
    [tickers],
  );

  return { tickers, has, add, remove, toggle, hydrated };
}
