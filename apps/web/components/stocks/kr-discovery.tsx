'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Flame,
  TrendingUp,
  Sparkles,
  Globe2,
  Search,
  Plus,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

interface SectionDef {
  id: DiscoveryMode;
  title: string;
  subtitle: string;
  icon: typeof Flame;
  accent: string;       // tailwind text color class
  accentBg: string;     // tailwind bg tint
}

const SECTIONS: SectionDef[] = [
  {
    id: 'popular',
    title: '인기 종목',
    subtitle: '거래대금 기준 가장 많이 거래된 종목',
    icon: Flame,
    accent: 'text-status-warning',
    accentBg: 'bg-status-warning/10',
  },
  {
    id: 'gainers',
    title: '급등 종목',
    subtitle: '오늘 가장 많이 오른 종목',
    icon: TrendingUp,
    accent: 'text-status-danger',
    accentBg: 'bg-status-danger/10',
  },
  {
    id: 'ai_pick',
    title: 'AI 추천 종목',
    subtitle: '7요소 종합 점수 상위',
    icon: Sparkles,
    accent: 'text-brand-purple',
    accentBg: 'bg-brand-purple/10',
  },
  {
    id: 'foreign_buy',
    title: '외국인 순매수',
    subtitle: '외국인이 가장 많이 사 모은 종목',
    icon: Globe2,
    accent: 'text-status-info',
    accentBg: 'bg-status-info/10',
  },
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

function formatChange(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

interface DiscoveryRowProps {
  rank: number;
  stock: DiscoveryStock;
  added: boolean;
  pending: boolean;
  onAdd: (ticker: string, name: string) => void;
}

function DiscoveryRow({ rank, stock, added, pending, onAdd }: DiscoveryRowProps) {
  return (
    <div
      className="group flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-bg-tertiary/40"
    >
      <div className="w-5 text-center text-xs font-mono text-txt-muted shrink-0">{rank}</div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium truncate">{stock.name}</span>
          <span className="text-[10px] font-mono text-txt-muted shrink-0">{stock.ticker}</span>
          <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-normal shrink-0">
            {stock.market}
          </Badge>
          {stock.signal && (
            <Badge
              variant="outline"
              className="h-4 px-1.5 text-[9px] font-normal border-brand-purple/40 text-brand-purple shrink-0"
            >
              {stock.signal}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-txt-secondary mt-0.5">
          <span className="truncate">{stock.sector ?? '—'}</span>
          {stock.highlight && (
            <>
              <span className="text-txt-muted">·</span>
              <span className="text-brand-purple font-medium">{stock.highlight}</span>
            </>
          )}
        </div>
      </div>

      <div className="text-right shrink-0">
        <div className="text-sm font-mono tabular-nums">{formatPrice(stock.close)}</div>
        <div className={'text-[11px] font-mono tabular-nums ' + changeClass(stock.change_rate)}>
          {formatChange(stock.change_rate)}
        </div>
      </div>

      <Button
        size="sm"
        variant="outline"
        disabled={added || pending}
        onClick={() => onAdd(stock.ticker, stock.name)}
        className="shrink-0 h-8 px-3 text-xs"
      >
        {added ? (
          <>
            <Check className="h-3 w-3 mr-1" />추가됨
          </>
        ) : (
          <>
            <Plus className="h-3 w-3 mr-1" />추가
          </>
        )}
      </Button>
    </div>
  );
}

interface SectionCardProps {
  def: SectionDef;
  market: DiscoveryMarket;
  added: Set<string>;
  pendingTicker: string | null;
  onAdd: (ticker: string, name: string) => void;
}

function SectionCard({ def, market, added, pendingTicker, onAdd }: SectionCardProps) {
  const [rows, setRows] = useState<DiscoveryStock[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    discoverUnaddedStocksAction(def.id, market, 12).then((data) => {
      if (cancelled) return;
      setRows(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [def.id, market]);

  const visibleRows = expanded ? rows : rows.slice(0, 5);
  const Icon = def.icon;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <div className={'h-8 w-8 rounded-md flex items-center justify-center ' + def.accentBg}>
            <Icon className={'h-4 w-4 ' + def.accent} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm">{def.title}</div>
            <div className="text-[11px] text-txt-muted">{def.subtitle}</div>
          </div>
          <span className="text-[11px] text-txt-muted">{rows.length}개</span>
        </div>

        <div className="space-y-0.5">
          {loading && (
            <p className="text-xs text-txt-muted px-2 py-3">불러오는 중...</p>
          )}
          {!loading && rows.length === 0 && (
            <p className="text-xs text-txt-muted px-2 py-3">
              해당 시장에 추가 가능한 종목이 없습니다.
            </p>
          )}
          {!loading &&
            visibleRows.map((s, i) => (
              <DiscoveryRow
                key={s.ticker}
                rank={i + 1}
                stock={s}
                added={added.has(s.ticker)}
                pending={pendingTicker === s.ticker}
                onAdd={onAdd}
              />
            ))}
        </div>

        {!loading && rows.length > 5 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            className="w-full h-8 text-xs text-txt-secondary hover:text-txt-primary"
          >
            {expanded ? '접기' : `더보기 (+${rows.length - 5})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

interface Props {
  initialWatchlistCount: number;
}

export function KrDiscovery({ initialWatchlistCount }: Props) {
  const router = useRouter();
  const [market, setMarket] = useState<DiscoveryMarket>('ALL');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchPending, startSearch] = useTransition();
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [pendingTicker, setPendingTicker] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const isSearching = query.trim().length > 0;
  const watchlistCount = initialWatchlistCount + added.size;

  // Debounced search
  useEffect(() => {
    if (!isSearching) {
      setSearchResults([]);
      return;
    }
    const handle = setTimeout(() => {
      startSearch(async () => {
        const data = await searchUnaddedKrStocksAction(query, market);
        setSearchResults(data);
      });
    }, 220);
    return () => clearTimeout(handle);
  }, [query, market, isSearching]);

  async function handleAdd(ticker: string, name: string) {
    setPendingTicker(ticker);
    try {
      const res = await adminAddToWatchlist(ticker);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} 관심 종목 추가됨`);
      setAdded((prev) => {
        const next = new Set(prev);
        next.add(ticker);
        return next;
      });
      setSearchResults((prev) => prev.filter((r) => r.ticker !== ticker));
      // Refresh router so /watchlist count is updated when navigating back
      router.refresh();
    } finally {
      setPendingTicker(null);
    }
  }

  // Force re-mount of section cards when market changes so each card refetches
  useMemo(() => setRefreshKey((k) => k + 1), [market]);

  return (
    <div className="space-y-5 fade-in">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">국내주식</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            거래대금·등락률·AI 점수·외국인 수급으로 KOSPI/KOSDAQ 종목을 발굴해 마스터 워치리스트에 추가합니다.
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs text-txt-muted">현재 워치리스트</div>
          <div className="text-lg font-semibold tabular-nums">
            {watchlistCount}{' '}
            <span className="text-xs font-normal text-txt-muted">종목</span>
          </div>
        </div>
      </div>

      {/* Search + market filter */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-muted" />
            <Input
              placeholder="종목명 또는 6자리 티커로 검색..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-9 h-11 text-base"
            />
            {isSearching && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-txt-muted hover:text-txt-primary"
              >
                지우기
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {MARKETS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMarket(m.id)}
                className={
                  'rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ' +
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
                : '추천 4개 카테고리 · 카드 클릭으로 즉시 추가'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Search results override */}
      {isSearching && (
        <Card>
          <CardContent className="p-4 space-y-1">
            <div className="flex items-center gap-2 mb-2">
              <Search className="h-4 w-4 text-brand-purple" />
              <span className="text-sm font-semibold">"{query}" 검색 결과</span>
            </div>
            {searchPending && (
              <p className="text-xs text-txt-muted px-2 py-3">검색 중...</p>
            )}
            {!searchPending && searchResults.length === 0 && (
              <p className="text-xs text-txt-muted px-2 py-3">
                결과가 없습니다 (이미 모두 추가됐거나 stocks 마스터에 없음).
              </p>
            )}
            <div className="space-y-0.5">
              {searchResults.map((r, i) => (
                <DiscoveryRow
                  key={r.ticker}
                  rank={i + 1}
                  stock={{
                    ticker: r.ticker,
                    name: r.name,
                    sector: r.sector,
                    market: r.market,
                    close: null,
                    change_rate: null,
                    volume: null,
                    trading_value: null,
                    foreign_net_buy: null,
                    final_score: null,
                    signal: null,
                    highlight: null,
                  }}
                  added={added.has(r.ticker)}
                  pending={pendingTicker === r.ticker}
                  onAdd={handleAdd}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 4-section grid */}
      {!isSearching && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {SECTIONS.map((s) => (
            <SectionCard
              key={`${s.id}-${refreshKey}`}
              def={s}
              market={market}
              added={added}
              pendingTicker={pendingTicker}
              onAdd={handleAdd}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-txt-muted">
        ※ 본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다. 카테고리는 직전 거래일 기준 데이터를 사용합니다.
      </p>
    </div>
  );
}
