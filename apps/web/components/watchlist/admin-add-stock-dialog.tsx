'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Search, TrendingUp, Flame, Sparkles, Globe2, Plus } from 'lucide-react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  adminAddToWatchlist,
  discoverUnaddedStocksAction,
  searchUnaddedKrStocksAction,
  type DiscoveryMarket,
  type DiscoveryMode,
  type DiscoveryStock,
} from '@/app/actions/watchlist';

interface SearchResult {
  ticker: string;
  name: string;
  sector: string | null;
  market: string;
}

const MARKETS: { id: DiscoveryMarket; label: string }[] = [
  { id: 'ALL', label: '전체' },
  { id: 'KOSPI', label: '코스피' },
  { id: 'KOSDAQ', label: '코스닥' },
];

const MODES: {
  id: DiscoveryMode;
  label: string;
  hint: string;
  icon: typeof Flame;
}[] = [
  { id: 'popular', label: '인기', hint: '거래대금 상위', icon: Flame },
  { id: 'gainers', label: '급등', hint: '상승률 상위', icon: TrendingUp },
  { id: 'ai_pick', label: 'AI 추천', hint: 'AI 점수 상위', icon: Sparkles },
  { id: 'foreign_buy', label: '외국인', hint: '순매수 상위', icon: Globe2 },
];

function formatPrice(v: number | null): string {
  if (v == null) return '—';
  return v.toLocaleString('ko-KR');
}

function changeClass(v: number | null): string {
  if (v == null) return 'text-txt-muted';
  if (v > 0) return 'text-status-danger';
  if (v < 0) return 'text-status-info';
  return 'text-txt-secondary';
}

/**
 * Admin discovery dialog inspired by Toss/Kakao 증권:
 *  - 4 curated tabs (인기 / 급등 / AI 추천 / 외국인)
 *  - KOSPI / KOSDAQ filter pills
 *  - debounced search bar that overrides the curated view when typed
 *  - rich stock card: name + ticker + sector, price + change%,
 *    AI signal badge, mode-specific highlight metric
 */
export function AdminAddStockDialog({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DiscoveryMode>('popular');
  const [market, setMarket] = useState<DiscoveryMarket>('ALL');
  const [query, setQuery] = useState('');
  const [discovery, setDiscovery] = useState<DiscoveryStock[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<string | null>(null);
  const queryRef = useRef('');

  const isSearching = query.trim().length > 0;

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery('');
      setSearchResults([]);
      setMode('popular');
      setMarket('ALL');
    }
  }, [open]);

  // Re-load curated list when mode/market changes (and not searching)
  useEffect(() => {
    if (!open || isSearching) return;
    startTransition(async () => {
      const data = await discoverUnaddedStocksAction(mode, market, 12);
      setDiscovery(data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, market, isSearching]);

  // Debounced search
  useEffect(() => {
    queryRef.current = query;
    if (!isSearching) {
      setSearchResults([]);
      return;
    }
    const handle = setTimeout(() => {
      if (queryRef.current !== query) return;
      startTransition(async () => {
        const data = await searchUnaddedKrStocksAction(query, market);
        setSearchResults(data);
      });
    }, 220);
    return () => clearTimeout(handle);
  }, [query, market, isSearching]);

  async function handleAdd(ticker: string, name: string) {
    setAdding(ticker);
    try {
      const res = await adminAddToWatchlist(ticker);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} 관심 종목 추가됨`);
      // Optimistic remove from local lists so the user sees the row drop
      setDiscovery((prev) => prev.filter((r) => r.ticker !== ticker));
      setSearchResults((prev) => prev.filter((r) => r.ticker !== ticker));
      router.refresh();
    } finally {
      setAdding(null);
    }
  }

  const activeMode = useMemo(() => MODES.find((m) => m.id === mode)!, [mode]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-2xl gap-4">
        <DialogHeader>
          <DialogTitle className="text-lg">관심 종목 발굴</DialogTitle>
          <DialogDescription className="text-xs text-txt-muted">
            카카오·토스 증권처럼 인기·급등·AI 추천을 한 번에. 카드를 누르면 바로 마스터 워치리스트에 추가됩니다.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-muted" />
          <Input
            placeholder="종목명 또는 6자리 티커 검색..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
          {isSearching && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-txt-muted hover:text-txt-primary"
            >
              지우기
            </button>
          )}
        </div>

        {/* Market pills */}
        <div className="flex items-center gap-1.5">
          {MARKETS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMarket(m.id)}
              className={
                'rounded-full px-3 py-1 text-xs font-medium transition-colors ' +
                (market === m.id
                  ? 'bg-gradient-brand text-white shadow-sm'
                  : 'bg-bg-secondary/70 text-txt-secondary hover:bg-bg-tertiary/70')
              }
            >
              {m.label}
            </button>
          ))}
          <span className="ml-auto text-[11px] text-txt-muted">
            {isSearching
              ? `검색결과 ${searchResults.length}개`
              : `${activeMode.hint} · ${discovery.length}개`}
          </span>
        </div>

        {/* Curated tabs */}
        {!isSearching && (
          <div className="grid grid-cols-4 gap-1.5">
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = m.id === mode;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className={
                    'flex flex-col items-center gap-1 rounded-md border px-2 py-2 transition-colors ' +
                    (active
                      ? 'border-brand-purple/50 bg-brand-purple/10 text-txt-primary'
                      : 'border-border bg-bg-secondary/50 text-txt-secondary hover:bg-bg-tertiary/60')
                  }
                >
                  <Icon
                    className={
                      'h-4 w-4 ' + (active ? 'text-brand-purple' : 'text-txt-muted')
                    }
                  />
                  <span className="text-xs font-medium">{m.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Result list */}
        <div className="max-h-[420px] overflow-y-auto space-y-1.5 pr-0.5">
          {pending && (
            <p className="text-xs text-txt-muted px-2 py-3">불러오는 중...</p>
          )}
          {!pending && isSearching && searchResults.length === 0 && (
            <p className="text-xs text-txt-muted px-2 py-3">
              결과가 없습니다 (이미 모두 추가됐거나 stocks 마스터에 없음).
            </p>
          )}
          {!pending && !isSearching && discovery.length === 0 && (
            <p className="text-xs text-txt-muted px-2 py-3">
              해당 카테고리에 추가 가능한 종목이 없습니다. 다른 시장이나 카테고리를 선택해 주세요.
            </p>
          )}

          {/* Search rows (lighter card — no quote enrichment) */}
          {isSearching &&
            searchResults.map((r) => (
              <button
                key={r.ticker}
                type="button"
                disabled={adding === r.ticker}
                onClick={() => handleAdd(r.ticker, r.name)}
                className="group w-full text-left rounded-lg border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 hover:border-brand-purple/40 px-3 py-2.5 transition-all"
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium truncate">{r.name}</span>
                      <span className="text-[11px] font-mono text-txt-muted">{r.ticker}</span>
                    </div>
                    <div className="text-[11px] text-txt-secondary mt-0.5">
                      {r.sector ?? r.market}
                    </div>
                  </div>
                  <Plus className="h-4 w-4 text-txt-muted group-hover:text-brand-purple" />
                </div>
              </button>
            ))}

          {/* Curated rich rows */}
          {!isSearching &&
            discovery.map((r, idx) => (
              <button
                key={r.ticker}
                type="button"
                disabled={adding === r.ticker}
                onClick={() => handleAdd(r.ticker, r.name)}
                className="group w-full text-left rounded-lg border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 hover:border-brand-purple/40 px-3 py-2.5 transition-all"
              >
                <div className="flex items-center gap-3">
                  {/* Rank */}
                  <div className="w-5 text-center text-xs font-mono text-txt-muted">
                    {idx + 1}
                  </div>

                  {/* Name / ticker / sector */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium truncate">{r.name}</span>
                      <span className="text-[10px] font-mono text-txt-muted">{r.ticker}</span>
                      <Badge
                        variant="outline"
                        className="ml-1 h-4 px-1.5 text-[9px] font-normal"
                      >
                        {r.market}
                      </Badge>
                      {r.signal && (
                        <Badge
                          variant="outline"
                          className="h-4 px-1.5 text-[9px] font-normal border-brand-purple/40 text-brand-purple"
                        >
                          {r.signal}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-txt-secondary mt-0.5">
                      <span className="truncate">{r.sector ?? '—'}</span>
                      {r.highlight && (
                        <>
                          <span className="text-txt-muted">·</span>
                          <span className="text-brand-purple font-medium">{r.highlight}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Price + change */}
                  <div className="text-right">
                    <div className="text-sm font-mono tabular-nums">{formatPrice(r.close)}</div>
                    <div className={'text-[11px] font-mono tabular-nums ' + changeClass(r.change_rate)}>
                      {r.change_rate == null
                        ? '—'
                        : `${r.change_rate >= 0 ? '+' : ''}${r.change_rate.toFixed(2)}%`}
                    </div>
                  </div>

                  <Plus className="h-4 w-4 text-txt-muted group-hover:text-brand-purple" />
                </div>
              </button>
            ))}
        </div>

        <div className="flex items-center justify-between pt-1">
          <p className="text-[10px] text-txt-muted">
            ※ 본 추천은 투자 판단 보조 자료이며 매매 권유가 아닙니다.
          </p>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
