'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleDot,
  Info,
  Pause,
  Play,
  Search,
  X,
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  fetchFinnhubSnapshot,
  useFinnhubTrades,
  type ConnState,
  type FinnhubSnapshot,
} from '@/lib/finnhub-ws';
import type { Role } from '@/lib/types';

export interface UsCandidate {
  symbol: string;
  name: string;
  sector: string | null;
}

const MAX_TRACKED = 8;

export function RealtimeMonitor({
  candidates,
  role,
}: {
  candidates: UsCandidate[];
  role: Role;
}) {
  // Default to first 4 candidates (mapped or fallback NVDA/TSM/AMD/AVGO)
  const [tracked, setTracked] = useState<UsCandidate[]>(() => candidates.slice(0, 4));
  const [query, setQuery] = useState('');
  const [paused, setPaused] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, FinnhubSnapshot>>({});
  const [snapshotErrs, setSnapshotErrs] = useState<Record<string, string>>({});

  const symbols = useMemo(
    () => (paused ? [] : tracked.map((c) => c.symbol)),
    [tracked, paused],
  );
  const { state, ticks } = useFinnhubTrades(symbols);

  // Snapshot once per new symbol so cards show open/high/low/prevClose
  // even before the first WS trade fires. We rely on the ref to dedupe
  // (StrictMode double-mounts effects) instead of a cancelled flag,
  // because cancelled would drop the first mount's in-flight result on
  // unmount while the ref-guard already prevents the second mount from
  // re-fetching.
  const fetchedSnapshotRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const c of tracked) {
      if (fetchedSnapshotRef.current.has(c.symbol)) continue;
      fetchedSnapshotRef.current.add(c.symbol);
      void fetchFinnhubSnapshot(c.symbol)
        .then((snap) => {
          setSnapshots((prev) => ({ ...prev, [c.symbol]: snap }));
        })
        .catch((e) => {
          // Allow retry on next mount if the request errored
          fetchedSnapshotRef.current.delete(c.symbol);
          setSnapshotErrs((prev) => ({
            ...prev,
            [c.symbol]: e instanceof Error ? e.message : 'snapshot error',
          }));
        });
    }
  }, [tracked]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const trackedSet = new Set(tracked.map((c) => c.symbol));
    if (!q) return [];
    const fromList = candidates
      .filter((c) => !trackedSet.has(c.symbol))
      .filter(
        (c) =>
          c.symbol.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          (c.sector ?? '').toLowerCase().includes(q),
      )
      .slice(0, 8);

    // Allow free-form ticker entry (uppercase A-Z, dots) if not in list
    const looksLikeTicker = /^[A-Z]{1,6}(\.[A-Z])?$/.test(query.trim().toUpperCase());
    if (
      fromList.length === 0 &&
      looksLikeTicker &&
      !trackedSet.has(query.trim().toUpperCase())
    ) {
      return [{ symbol: query.trim().toUpperCase(), name: '직접 입력 종목', sector: null }];
    }
    return fromList;
  }, [query, candidates, tracked]);

  const addTicker = (c: UsCandidate) => {
    if (tracked.length >= MAX_TRACKED) return;
    if (tracked.some((t) => t.symbol === c.symbol)) return;
    setTracked((prev) => [...prev, c]);
    setQuery('');
  };
  const removeTicker = (symbol: string) => {
    setTracked((prev) => prev.filter((t) => t.symbol !== symbol));
    fetchedSnapshotRef.current.delete(symbol);
    setSnapshots((prev) => {
      const next = { ...prev };
      delete next[symbol];
      return next;
    });
  };

  return (
    <div className="space-y-5 fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            실시간 시세 모니터
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-txt-secondary">
            <Activity className="h-3.5 w-3.5 text-status-success" />
            Finnhub WebSocket · 미국주식 체결 실시간 (IEX) · 최대 {MAX_TRACKED}종목
            <ConnBadge state={state} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            disabled={tracked.length === 0}
          >
            {paused ? (
              <>
                <Play className="h-3.5 w-3.5 mr-1" />
                재개
              </>
            ) : (
              <>
                <Pause className="h-3.5 w-3.5 mr-1" />
                일시 정지
              </>
            )}
          </Button>
        </div>
      </header>

      {/* Korea coming-soon notice */}
      <Card className="border-status-info/40 bg-status-info/5">
        <CardContent className="flex items-start gap-3 p-4 text-sm">
          <Info className="h-4 w-4 text-status-info shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-medium">한국주식 실시간은 추후 추가됩니다.</p>
            <p className="text-txt-secondary">
              KIS Open API(한국투자증권 계좌 필요)를 연동하면 KRX 체결가가 동일 화면에 푸시됩니다.
              {role !== 'admin' && ' 관리자 안내를 기다려주세요.'}
            </p>
          </div>
        </CardContent>
      </Card>

      {state === 'no-key' && (
        <Card className="border-status-warning/40 bg-status-warning/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="h-4 w-4 text-status-warning shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">NEXT_PUBLIC_FINNHUB_KEY가 설정되지 않았습니다.</p>
              <p className="text-txt-secondary">
                <a
                  className="underline text-brand-purple"
                  href="https://finnhub.io/dashboard"
                  target="_blank"
                  rel="noreferrer"
                >
                  finnhub.io
                </a>
                에서 무료 키를 발급한 뒤{' '}
                <code className="text-xs bg-bg-tertiary px-1 py-0.5 rounded">
                  apps/web/.env.local
                </code>{' '}
                에 <code className="text-xs">NEXT_PUBLIC_FINNHUB_KEY=...</code> 를 추가하고 dev
                서버를 재시작하세요. (무료, IEX 체결 실시간 푸시)
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Search to add */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-txt-muted" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="티커·이름·섹터 검색 (예: NVDA, 반도체) — 또는 미국 티커 직접 입력"
              className="h-9"
              disabled={tracked.length >= MAX_TRACKED}
            />
            <Badge variant="outline" className="shrink-0">
              {tracked.length}/{MAX_TRACKED}
            </Badge>
          </div>
          {filtered.length > 0 && (
            <ul className="space-y-1">
              {filtered.map((c) => (
                <li key={c.symbol}>
                  <button
                    type="button"
                    onClick={() => addTicker(c)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-sm text-sm hover:bg-[var(--sidebar-hover)] text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-txt-muted">{c.symbol}</span>
                      <span>{c.name}</span>
                    </span>
                    <span className="text-xs text-txt-muted">{c.sector ?? '—'}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tracked.length >= MAX_TRACKED && (
            <p className="text-xs text-txt-muted">최대 {MAX_TRACKED}종목까지 추적 가능합니다.</p>
          )}
        </CardContent>
      </Card>

      {/* Live grid */}
      {tracked.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-txt-secondary">
            추적할 미국 종목을 검색해서 추가하세요.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {tracked.map((c) => (
            <QuoteCard
              key={c.symbol}
              candidate={c}
              snapshot={snapshots[c.symbol]}
              snapshotErr={snapshotErrs[c.symbol]}
              tickPrice={ticks[c.symbol]?.price}
              tickTimestamp={ticks[c.symbol]?.timestamp}
              tickVolume={ticks[c.symbol]?.volume}
              onRemove={() => removeTicker(c.symbol)}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 Finnhub이 제공하는 IEX 체결 실시간 시세이며 매매 권유가 아닙니다. 정규 장
        외에는 거래가 멈춰 있을 수 있습니다.
      </p>
    </div>
  );
}

function ConnBadge({ state }: { state: ConnState }) {
  const map: Record<ConnState, { label: string; cls: string }> = {
    idle: { label: '대기', cls: 'text-txt-muted' },
    connecting: { label: '연결 중', cls: 'text-status-warning' },
    open: { label: 'LIVE', cls: 'text-status-success' },
    closed: { label: '재연결 중', cls: 'text-status-warning' },
    error: { label: '오류', cls: 'text-status-danger' },
    'no-key': { label: 'API KEY 없음', cls: 'text-status-danger' },
  };
  const { label, cls } = map[state];
  return (
    <Badge variant="outline" className={cn('ml-1 align-middle inline-flex items-center gap-1', cls)}>
      <CircleDot className={cn('h-2.5 w-2.5', state === 'open' && 'animate-pulse')} />
      {label}
    </Badge>
  );
}

function QuoteCard({
  candidate,
  snapshot,
  snapshotErr,
  tickPrice,
  tickTimestamp,
  tickVolume,
  onRemove,
}: {
  candidate: UsCandidate;
  snapshot?: FinnhubSnapshot;
  snapshotErr?: string;
  tickPrice?: number;
  tickTimestamp?: number;
  tickVolume?: number;
  onRemove: () => void;
}) {
  // Live price prefers WS tick; falls back to snapshot.current
  const price = tickPrice ?? snapshot?.current ?? null;
  const prevClose = snapshot?.prevClose ?? null;

  const change = price != null && prevClose != null ? price - prevClose : (snapshot?.change ?? null);
  const changePct =
    price != null && prevClose != null && prevClose !== 0
      ? ((price - prevClose) / prevClose) * 100
      : (snapshot?.changePercent ?? null);
  const isUp = change != null ? change > 0 : null;

  // tick flash (US convention: green up, red down)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const lastPriceRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (tickPrice == null) return;
    const last = lastPriceRef.current;
    lastPriceRef.current = tickPrice;
    if (last == null) return;
    if (tickPrice > last) setFlash('up');
    else if (tickPrice < last) setFlash('down');
    else return;
    const id = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(id);
  }, [tickPrice]);

  const tickLabel = tickTimestamp
    ? new Date(tickTimestamp).toLocaleTimeString('ko-KR', { hour12: false })
    : null;

  return (
    <Card
      className={cn(
        'transition-colors',
        flash === 'up' && 'border-status-success/60 bg-status-success/5',
        flash === 'down' && 'border-status-danger/60 bg-status-danger/5',
      )}
    >
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-txt-muted">{candidate.symbol}</span>
              <Badge variant="outline" className="text-[10px]">
                US
              </Badge>
              {tickLabel && (
                <span className="text-[10px] text-txt-muted">최근 체결 {tickLabel}</span>
              )}
            </div>
            <h3 className="mt-0.5 font-medium truncate">{candidate.name}</h3>
            <p className="text-xs text-txt-muted truncate">{candidate.sector ?? '—'}</p>
          </div>
          <button
            type="button"
            onClick={onRemove}
            className="text-txt-muted hover:text-txt-primary p-1 -m-1"
            aria-label="추적 해제"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {snapshotErr && !price ? (
          <div className="text-xs text-status-danger">스냅샷 실패: {snapshotErr}</div>
        ) : price == null ? (
          <div className="text-xs text-txt-muted">조회 중…</div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
                ${price.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
              </span>
              <span
                className={cn(
                  'flex items-center gap-1 text-sm font-medium tabular-nums',
                  // US convention (green up, red down) — matches Finnhub source
                  isUp === true && 'text-status-success',
                  isUp === false && 'text-status-danger',
                  isUp === null && 'text-txt-muted',
                )}
              >
                {isUp === true ? (
                  <ArrowUpRight className="h-3.5 w-3.5" />
                ) : isUp === false ? (
                  <ArrowDownRight className="h-3.5 w-3.5" />
                ) : null}
                {change != null
                  ? `${change > 0 ? '+' : ''}${change.toFixed(2)}`
                  : '—'}{' '}
                {changePct != null
                  ? `(${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%)`
                  : ''}
              </span>
            </div>

            <dl className="grid grid-cols-3 gap-2 text-xs text-txt-secondary">
              <Stat label="시가" value={snapshot?.open} />
              <Stat label="고가" value={snapshot?.high} />
              <Stat label="저가" value={snapshot?.low} />
              <Stat label="전일종가" value={snapshot?.prevClose} />
              <Stat
                label="체결량"
                value={tickVolume}
                fmt={(v) => Number(v).toLocaleString('en-US')}
              />
              <Stat
                label="기준일"
                value={
                  snapshot?.timestamp
                    ? new Date(snapshot.timestamp).toISOString().slice(0, 10)
                    : null
                }
                fmt={(v) => String(v)}
              />
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  fmt,
}: {
  label: string;
  value: number | string | null | undefined;
  fmt?: (v: number | string) => string;
}) {
  const display =
    value == null
      ? '—'
      : fmt
        ? fmt(value as number | string)
        : typeof value === 'number'
          ? `$${value.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
          : String(value);
  return (
    <div>
      <dt className="text-txt-muted text-[10px] uppercase tracking-wider">{label}</dt>
      <dd className="tabular-nums">{display}</dd>
    </div>
  );
}
