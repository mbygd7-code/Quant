'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Pause,
  Play,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface Candidate {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
}

interface QuoteResult {
  ok: boolean;
  symbol: string;
  price?: number | null;
  change?: number | null;
  changePercent?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  volume?: number | null;
  latestTradingDay?: string | null;
  code?: string;
  message?: string;
}

interface Snapshot {
  fetchedAt: string;
  results: QuoteResult[];
}

const MAX_TRACKED = 5;
const POLL_MS = 15_000;

export function RealtimeMonitor({
  candidates,
  hasKey,
}: {
  candidates: Candidate[];
  hasKey: boolean;
}) {
  const [tracked, setTracked] = useState<Candidate[]>(() => candidates.slice(0, 3));
  const [query, setQuery] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [prevPrices, setPrevPrices] = useState<Record<string, number>>({});
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trackedKey = useMemo(() => tracked.map((c) => c.ticker).join(','), [tracked]);
  const lastFetchRef = useRef<number>(0);

  const fetchQuotes = useCallback(async () => {
    if (tracked.length === 0) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const symbols = tracked.map((c) => c.ticker).join(',');
      const res = await fetch(`/api/realtime/quote?symbols=${encodeURIComponent(symbols)}`, {
        cache: 'no-store',
      });
      const json = (await res.json()) as Snapshot | { error: string };
      if ('error' in json) {
        setError(json.error);
        return;
      }
      setPrevPrices((prev) => {
        const next = { ...prev };
        for (const r of snapshot?.results ?? []) {
          if (r.ok && r.price != null) next[r.symbol] = r.price;
        }
        return next;
      });
      setSnapshot(json);
      lastFetchRef.current = Date.now();
      const rateLimit = json.results.find((r) => !r.ok && r.code === 'RATE_LIMIT');
      if (rateLimit) setError(`API 호출 한도 초과: ${rateLimit.message}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청 실패');
    } finally {
      setLoading(false);
    }
    // snapshot intentionally omitted; we read previous via ref pattern above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked]);

  // initial + polling
  useEffect(() => {
    if (!hasKey) return;
    if (paused) return;
    void fetchQuotes();
    const id = setInterval(() => void fetchQuotes(), POLL_MS);
    return () => clearInterval(id);
  }, [trackedKey, paused, hasKey, fetchQuotes]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const trackedTickers = new Set(tracked.map((c) => c.ticker));
    if (!q) return [];
    return candidates
      .filter((c) => !trackedTickers.has(c.ticker))
      .filter(
        (c) =>
          c.ticker.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          (c.sector ?? '').toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [query, candidates, tracked]);

  const addTicker = (c: Candidate) => {
    if (tracked.length >= MAX_TRACKED) return;
    if (tracked.some((t) => t.ticker === c.ticker)) return;
    setTracked((prev) => [...prev, c]);
    setQuery('');
  };
  const removeTicker = (ticker: string) =>
    setTracked((prev) => prev.filter((t) => t.ticker !== ticker));

  const fetchedLabel = snapshot?.fetchedAt
    ? new Date(snapshot.fetchedAt).toLocaleTimeString('ko-KR', { hour12: false })
    : '—';

  return (
    <div className="space-y-5 fade-in">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            실시간 시세 모니터
          </h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-txt-secondary">
            <Activity className="h-3.5 w-3.5 text-status-success" />
            Alpha Vantage · 최대 {MAX_TRACKED}종목 · {POLL_MS / 1000}초 주기
            <Badge variant="outline" className="ml-1 align-middle">
              지연 시세 (15분)
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-txt-muted">최근 갱신 {fetchedLabel}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused((p) => !p)}
            disabled={!hasKey || tracked.length === 0}
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
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchQuotes()}
            disabled={!hasKey || loading || tracked.length === 0}
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1', loading && 'animate-spin')} />
            새로고침
          </Button>
        </div>
      </header>

      {!hasKey && (
        <Card className="border-status-warning/40 bg-status-warning/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="h-4 w-4 text-status-warning shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">ALPHA_VANTAGE_KEY가 설정되지 않았습니다.</p>
              <p className="text-txt-secondary">
                <a
                  className="underline text-brand-purple"
                  href="https://www.alphavantage.co/support/#api-key"
                  target="_blank"
                  rel="noreferrer"
                >
                  alphavantage.co
                </a>
                에서 무료 키를 발급한 뒤{' '}
                <code className="text-xs bg-bg-tertiary px-1 py-0.5 rounded">
                  apps/web/.env.local
                </code>{' '}
                에 <code className="text-xs">ALPHA_VANTAGE_KEY=...</code> 로 추가하고 dev 서버를
                재시작하세요. (무료 25회/일, 5회/분)
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-status-danger/40 bg-status-danger/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <AlertTriangle className="h-4 w-4 text-status-danger shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{error}</p>
              <p className="text-txt-secondary mt-1">
                폴링은 일시 정지 상태로 두는 것을 권장합니다 — 무료 티어(25회/일) 한도 내에서 수동
                새로고침을 사용하세요.
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
              placeholder="관심종목에서 추적할 티커·이름·섹터 검색"
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
                <li key={c.ticker}>
                  <button
                    type="button"
                    onClick={() => addTicker(c)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-sm text-sm hover:bg-[var(--sidebar-hover)] text-left"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs text-txt-muted">{c.ticker}</span>
                      <span>{c.name}</span>
                    </span>
                    <span className="text-xs text-txt-muted">
                      {c.market} · {c.sector ?? '—'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {tracked.length >= MAX_TRACKED && (
            <p className="text-xs text-txt-muted">
              최대 {MAX_TRACKED}종목까지 추적할 수 있습니다. 분당 5회 호출 한도를 보호합니다.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Live grid */}
      {tracked.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-txt-secondary">
            추적할 종목을 검색해서 추가하세요. 관심종목에 등록된 종목만 검색됩니다.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {tracked.map((c) => {
            const q = snapshot?.results.find((r) => r.symbol === c.ticker);
            const prev = prevPrices[c.ticker];
            return (
              <QuoteCard
                key={c.ticker}
                candidate={c}
                quote={q}
                prevPrice={prev}
                onRemove={() => removeTicker(c.ticker)}
              />
            );
          })}
        </div>
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 Alpha Vantage가 제공하는 지연 시세이며 매매 권유가 아닙니다. 호가·체결 등
        실시간 정보는 증권사 공식 단말을 사용하세요.
      </p>
    </div>
  );
}

function QuoteCard({
  candidate,
  quote,
  prevPrice,
  onRemove,
}: {
  candidate: Candidate;
  quote?: QuoteResult;
  prevPrice?: number;
  onRemove: () => void;
}) {
  const price = quote?.price ?? null;
  const changePct = quote?.changePercent ?? null;
  const change = quote?.change ?? null;
  const isUp = change != null ? change > 0 : null;

  // tick flash colour vs previous render
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  useEffect(() => {
    if (price == null || prevPrice == null) return;
    if (price > prevPrice) setFlash('up');
    else if (price < prevPrice) setFlash('down');
    else return;
    const id = setTimeout(() => setFlash(null), 800);
    return () => clearTimeout(id);
  }, [price, prevPrice]);

  const failed = quote && !quote.ok;

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
              <span className="font-mono text-xs text-txt-muted">{candidate.ticker}</span>
              <Badge variant="outline" className="text-[10px]">
                {candidate.market}
              </Badge>
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

        {failed ? (
          <div className="text-xs text-status-danger">
            {quote?.code === 'RATE_LIMIT'
              ? '호출 한도 도달'
              : quote?.code === 'BAD_SYMBOL'
                ? '심볼 미지원 (Alpha Vantage)'
                : (quote?.message ?? '조회 실패')}
          </div>
        ) : price == null ? (
          <div className="text-xs text-txt-muted">조회 중…</div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-heading text-2xl font-semibold tracking-tight tabular-nums">
                {price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}
              </span>
              <span
                className={cn(
                  'flex items-center gap-1 text-sm font-medium tabular-nums',
                  isUp === true && 'text-status-danger',
                  isUp === false && 'text-status-info',
                  isUp === null && 'text-txt-muted',
                )}
              >
                {isUp === true ? (
                  <ArrowUpRight className="h-3.5 w-3.5" />
                ) : isUp === false ? (
                  <ArrowDownRight className="h-3.5 w-3.5" />
                ) : null}
                {change != null
                  ? `${change > 0 ? '+' : ''}${change.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}`
                  : '—'}{' '}
                {changePct != null
                  ? `(${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%)`
                  : ''}
              </span>
            </div>

            <dl className="grid grid-cols-3 gap-2 text-xs text-txt-secondary">
              <Stat label="시가" value={quote?.open} />
              <Stat label="고가" value={quote?.high} />
              <Stat label="저가" value={quote?.low} />
              <Stat label="전일종가" value={quote?.prevClose} />
              <Stat
                label="거래량"
                value={quote?.volume}
                fmt={(v) => v.toLocaleString('ko-KR')}
              />
              <Stat label="기준일" value={quote?.latestTradingDay} fmt={(v) => String(v)} />
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
          ? value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })
          : String(value);
  return (
    <div>
      <dt className="text-txt-muted text-[10px] uppercase tracking-wider">{label}</dt>
      <dd className="tabular-nums">{display}</dd>
    </div>
  );
}
