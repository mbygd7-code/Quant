'use client';

/**
 * Finnhub WebSocket hook — US equity trade ticks (IEX, real-time).
 *
 * Free tier: unlimited subscriptions but Finnhub recommends ≤ 50 symbols
 * per connection. We cap at 12 to keep the UI legible.
 *
 * The token is exposed to the browser intentionally (NEXT_PUBLIC_FINNHUB_KEY).
 * Per Finnhub docs this is the only way to authenticate WS, and the free
 * key is rate-limited at the upstream so abuse impact is bounded.
 */
import { useEffect, useRef, useState } from 'react';

export interface Tick {
  symbol: string;
  price: number;
  timestamp: number; // ms epoch
  volume: number;
  conditions?: string[];
}

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'no-key';

const ENDPOINT = 'wss://ws.finnhub.io';
const RECONNECT_MS = 3_000;
const MAX_SYMBOLS = 12;

export function useFinnhubTrades(symbols: string[]) {
  // NEXT_PUBLIC_* is inlined at build time on both server and client, so
  // no `typeof window` gate — gating caused a hydration mismatch (server
  // saw undefined → 'no-key', client saw the key → 'idle').
  const token = process.env.NEXT_PUBLIC_FINNHUB_KEY;

  const [state, setState] = useState<ConnState>(token ? 'idle' : 'no-key');
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const subscribedRef = useRef<Set<string>>(new Set());

  const symbolKey = symbols.slice(0, MAX_SYMBOLS).join(',');

  useEffect(() => {
    if (!token) {
      setState('no-key');
      return;
    }
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const wanted = new Set(symbols.slice(0, MAX_SYMBOLS).map((s) => s.toUpperCase()));

    const connect = () => {
      setState('connecting');
      const ws = new WebSocket(`${ENDPOINT}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (cancelled) return;
        setState('open');
        subscribedRef.current = new Set();
        wanted.forEach((s) => {
          ws.send(JSON.stringify({ type: 'subscribe', symbol: s }));
          subscribedRef.current.add(s);
        });
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as
            | { type: 'trade'; data: Array<{ s: string; p: number; t: number; v: number; c?: string[] }> }
            | { type: 'ping' }
            | { type: 'error'; msg?: string };
          if (msg.type === 'trade') {
            setTicks((prev) => {
              const next = { ...prev };
              for (const d of msg.data) {
                next[d.s] = {
                  symbol: d.s,
                  price: d.p,
                  timestamp: d.t,
                  volume: d.v,
                  conditions: d.c,
                };
              }
              return next;
            });
          } else if (msg.type === 'error') {
            console.warn('[finnhub-ws] error:', msg.msg);
          }
        } catch {
          /* ignore */
        }
      };

      ws.onerror = () => {
        if (cancelled) return;
        setState('error');
      };

      ws.onclose = () => {
        if (cancelled) return;
        setState('closed');
        reconnectTimer = setTimeout(connect, RECONNECT_MS);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        subscribedRef.current.forEach((s) => {
          try {
            ws.send(JSON.stringify({ type: 'unsubscribe', symbol: s }));
          } catch {
            /* ignore */
          }
        });
      }
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbolKey, token]);

  return { state, ticks };
}

/**
 * REST fallback for an initial snapshot (price/open/high/low/prevClose).
 * One call per symbol — used when WS connects so cards aren't blank
 * before the first trade tick fires.
 */
export interface FinnhubSnapshot {
  symbol: string;
  current: number | null;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  timestamp: number | null;
}

export async function fetchFinnhubSnapshot(symbol: string): Promise<FinnhubSnapshot> {
  const token = process.env.NEXT_PUBLIC_FINNHUB_KEY;
  if (!token) throw new Error('NEXT_PUBLIC_FINNHUB_KEY not set');
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`finnhub ${res.status}`);
  const j = (await res.json()) as {
    c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number;
  };
  return {
    symbol,
    current: j.c || null,
    change: j.d ?? null,
    changePercent: j.dp ?? null,
    open: j.o || null,
    high: j.h || null,
    low: j.l || null,
    prevClose: j.pc || null,
    timestamp: j.t ? j.t * 1000 : null,
  };
}
