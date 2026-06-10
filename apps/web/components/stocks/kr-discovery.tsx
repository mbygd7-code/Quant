'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Flame,
  TrendingUp,
  Sparkles,
  Globe2,
  Search,
  Plus,
  Check,
  ListTodo,
} from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  adminAddOrCreateStockAction,
  adminAddToWatchlist,
  discoverUnaddedStocksAction,
  searchAllKrStocksAction,
  type AllKrSearchResult,
  type DiscoveryMarket,
  type DiscoveryMode,
  type DiscoveryStock,
} from '@/app/actions/watchlist';
import { useKrQuotes, type KrLiveQuote } from '@/lib/use-kr-quotes';
import { Sparkline, useKrSparkline } from '@/components/charts/sparkline';
import { StockChart } from '@/components/charts/stock-chart';
import { ChevronDown, ChevronUp } from 'lucide-react';

// Search result row from the full KRX catalog (Finnhub).
type SearchResult = AllKrSearchResult;

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
    title: 'AI 주목 종목',
    subtitle: '9요소 종합 점수 상위',
    icon: Sparkles,
    accent: 'text-txt-primary',
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
  live?: KrLiveQuote;
  added: boolean;
  pending: boolean;
  onAdd: (ticker: string, name: string) => void;
}

function DiscoveryRow({ rank, stock, live, added, pending, onAdd }: DiscoveryRowProps) {
  const price = live?.price ?? stock.close;
  const changeRate = live?.changeRate ?? stock.change_rate;
  const change = live?.change ?? null;
  const [expanded, setExpanded] = useState(false);
  const { candles, loading: sparkLoading } = useKrSparkline(stock.ticker, true, 30);

  return (
    <div className="group rounded-md transition-colors hover:bg-bg-tertiary/40">
      <div className="flex items-center gap-3 px-2 py-2">
        <div className="w-5 text-center text-xs font-mono text-txt-muted shrink-0">{rank}</div>

        <Link
          href={`/stocks/kr/${stock.ticker}`}
          className="flex-1 min-w-0 group/link"
        >
          <div className="flex items-baseline gap-2">
            <span className="font-medium truncate group-hover/link:text-txt-primary transition-colors">
              {/* Prefer the Korean name; fall back to the 6-digit code only
                  when a name is missing so the row is never unidentifiable. */}
              {stock.name || stock.ticker}
            </span>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] font-normal shrink-0">
              {stock.market}
            </Badge>
            {stock.signal && (
              <Badge
                variant="outline"
                className="h-4 px-1.5 text-[9px] font-normal border-brand-purple/40 text-txt-primary shrink-0"
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
                <span className="text-txt-primary font-medium">{stock.highlight}</span>
              </>
            )}
          </div>
        </Link>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 hidden sm:block"
          aria-label="차트 보기"
        >
          <Sparkline data={candles} loading={sparkLoading} width={50} height={20} convention="kr" />
        </button>

        <div className="text-right shrink-0 min-w-[88px]">
          <div className="text-sm font-mono tabular-nums">
            {price != null ? `${formatPrice(price)}원` : '—'}
          </div>
          <div className={'text-[11px] font-mono tabular-nums ' + changeClass(changeRate)}>
            {change != null && Math.abs(change) > 0
              ? `${change > 0 ? '+' : ''}${formatPrice(change)} `
              : ''}
            {formatChange(changeRate)}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="shrink-0 text-txt-muted hover:text-txt-primary p-1"
          aria-label={expanded ? '차트 접기' : '차트 펼치기'}
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

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

      {expanded && (
        <div className="px-2 pb-3 pt-1">
          <StockChart ticker={stock.ticker} variant="kr" height={180} />
        </div>
      )}
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

// Module-level SWR-style cache. Each (mode, market) key keeps the last
// successful response in memory + a timestamp. On re-mount we paint
// cached rows immediately (no skeleton flash), then revalidate in the
// background. TTL is intentionally generous (90s) because the upstream
// — NAVER ranking snapshots — only changes meaningfully every minute or
// so during market hours, and not at all after 15:30 KST.
//
// This cache lives in the JS heap of the running SPA session: navigating
// 국내주식 → 종목 상세 → 국내주식 keeps the cache warm. A hard refresh
// (server-side re-render) starts cold — that's intentional, server-side
// fetch caching (`next: { revalidate: 60 }`) covers that path separately.
const DISCOVERY_CACHE = new Map<
  string,
  { rows: DiscoveryStock[]; ts: number }
>();
const DISCOVERY_TTL_MS = 90_000;

function SectionCard({ def, market, added, pendingTicker, onAdd }: SectionCardProps) {
  const cacheKey = `${def.id}:${market}`;
  // Seed initial state from the cache so the first paint already shows rows.
  const cached = DISCOVERY_CACHE.get(cacheKey);
  const [rows, setRows] = useState<DiscoveryStock[]>(cached?.rows ?? []);
  const [loading, setLoading] = useState(!cached);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const c = DISCOVERY_CACHE.get(cacheKey);
    // If cached and still fresh, skip the network call entirely.
    if (c && Date.now() - c.ts < DISCOVERY_TTL_MS) {
      setRows(c.rows);
      setLoading(false);
      return;
    }
    // Otherwise: paint cached rows (if any) so the user isn't staring at
    // a spinner, then revalidate. Only flip `loading` when we have no
    // cached fallback to show.
    if (!c) setLoading(true);
    discoverUnaddedStocksAction(def.id, market, 12).then((data) => {
      if (cancelled) return;
      DISCOVERY_CACHE.set(cacheKey, { rows: data, ts: Date.now() });
      setRows(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [def.id, market, cacheKey]);

  const visibleRows = expanded ? rows : rows.slice(0, 5);
  const visibleTickers = useMemo(() => visibleRows.map((r) => r.ticker), [visibleRows]);
  const { quotes: liveQuotes } = useKrQuotes(visibleTickers);
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
                live={liveQuotes.get(s.ticker)}
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

interface SearchResultsProps {
  query: string;
  pending: boolean;
  rows: SearchResult[];
  added: Set<string>;
  pendingTicker: string | null;
  onAdd: (ticker: string, name: string) => void;
}

function SearchResults({
  query,
  pending,
  rows,
  added,
  pendingTicker,
  onAdd,
}: SearchResultsProps) {
  const tickers = useMemo(() => rows.map((r) => r.ticker), [rows]);
  const { quotes: liveQuotes } = useKrQuotes(tickers);
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center gap-2 mb-2">
          <Search className="h-4 w-4 text-txt-primary" />
          <span className="text-sm font-semibold">&ldquo;{query}&rdquo; 검색 결과</span>
        </div>
        {pending && <p className="text-xs text-txt-muted px-2 py-3">검색 중...</p>}
        {!pending && rows.length === 0 && (
          <p className="text-xs text-txt-muted px-2 py-3">
            결과가 없습니다. 종목명 일부 또는 6자리 티커로 다시 검색해 보세요.
          </p>
        )}
        <div className="space-y-0.5">
          {rows.map((r, i) => (
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
                highlight: r.inWatchlist
                  ? '이미 워치리스트'
                  : r.inMaster
                    ? '마스터 등록됨'
                    : '새 종목 (마스터 추가)',
              }}
              live={liveQuotes.get(r.ticker)}
              added={added.has(r.ticker) || r.inWatchlist}
              pending={pendingTicker === r.ticker}
              onAdd={onAdd}
            />
          ))}
        </div>
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
        const data = await searchAllKrStocksAction(query, market, 30);
        setSearchResults(data);
      });
    }, 220);
    return () => clearTimeout(handle);
  }, [query, market, isSearching]);

  async function handleAdd(ticker: string, name: string) {
    setPendingTicker(ticker);
    try {
      // If we have a search-result match (full KRX catalog), use the
      // upsert action so previously-unknown tickers are inserted into
      // stocks first. Discovery rows from local DB always exist in
      // master, so the simple flag-flip works.
      const fromCatalog = searchResults.find((r) => r.ticker === ticker);
      const res = fromCatalog
        ? await adminAddOrCreateStockAction({
            ticker,
            name,
            market: fromCatalog.market,
            sector: fromCatalog.sector,
          })
        : await adminAddToWatchlist(ticker);
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
        <Button asChild variant="outline" className="h-9">
          <Link href="/watchlist">
            <ListTodo className="h-4 w-4 mr-1.5" />
            주식리스트
            <span className="ml-1.5 rounded-full bg-bg-tertiary/60 px-2 py-0.5 text-[11px] font-medium tabular-nums">
              {watchlistCount}
            </span>
          </Link>
        </Button>
      </div>

      {/* Search + market filter */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-muted" />
            <Input
              placeholder="KOSPI/KOSDAQ 전체 종목 검색 (종목명 또는 6자리 티커)..."
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
                : '탐색 4개 카테고리 · 카드 클릭으로 즉시 추가'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Search results override */}
      {isSearching && (
        <SearchResults
          query={query}
          pending={searchPending}
          rows={searchResults}
          added={added}
          pendingTicker={pendingTicker}
          onAdd={handleAdd}
        />
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
