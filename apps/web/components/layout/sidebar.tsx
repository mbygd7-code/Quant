'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronDown,
  ChevronRight,
  Layers3,
  ListTodo,
  Loader2,
  Plus,
  Search,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFavorites } from '@/lib/use-favorites';
import { KR_TICKER_RE } from '@/lib/ticker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Role = 'user' | 'beta' | 'admin';

interface WatchlistItem {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  signal: string | null;
  final_score: number | null;
  change_rate: number | null;
}

function signalColor(signal: string | null): string {
  switch (signal) {
    case '강한 관심': return 'var(--status-success)';
    case '관심':      return '#7CC97E';
    case '관망':      return 'var(--txt-muted)';
    case '주의':      return '#E9B247';
    case '위험':      return 'var(--status-danger)';
    default:          return 'var(--border-default)';
  }
}

// Personal favorites — see `apps/web/lib/use-favorites.ts`. The hook is
// shared with the /watchlist ★ toggle so both stay in lockstep.

export function Sidebar({ role, variant = 'desktop' }: { role: Role; variant?: 'desktop' | 'sheet' }) {
  const pathname = usePathname();
  void role;

  const [universe, setUniverse] = useState<WatchlistItem[] | null>(null);
  const [extraMeta, setExtraMeta] = useState<Map<string, { name: string; market: string; sector: string | null }>>(
    () => new Map(),
  );
  const [openSection, setOpenSection] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { tickers, add, remove, hydrated } = useFavorites();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/watchlist-list', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { items?: WatchlistItem[] }) => {
        if (!cancelled) setUniverse(j.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setUniverse([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const universeByTicker = useMemo(() => {
    const m = new Map<string, WatchlistItem>();
    for (const it of universe ?? []) m.set(it.ticker, it);
    return m;
  }, [universe]);

  // Resolve names for favorites not in the universe (e.g. user-added tickers
  // outside the AI-tracked watchlist). Fires whenever the favorites set or
  // the universe changes — the API is cached upstream so re-calls are cheap.
  useEffect(() => {
    if (!hydrated || universe === null) return;
    // A ticker is "missing a real name" if it's not in the universe at all
    // OR the universe row's name is just the ticker code (placeholder added
    // by an auto-create flow before NAVER resolution).
    const missing = tickers.filter((t) => {
      if (extraMeta.has(t)) return false;
      const hit = universeByTicker.get(t);
      if (!hit) return true;
      return hit.name === t || hit.name.trim() === '';
    });
    if (missing.length === 0) return;
    let cancelled = false;
    fetch(`/api/stocks/resolve?tickers=${encodeURIComponent(missing.join(','))}`)
      .then((r) => r.json())
      .then((j: { items?: Array<{ ticker: string; name: string; market: string; sector: string | null }> }) => {
        if (cancelled) return;
        setExtraMeta((prev) => {
          const next = new Map(prev);
          for (const it of j.items ?? []) {
            next.set(it.ticker, { name: it.name, market: it.market, sector: it.sector });
          }
          return next;
        });
      })
      .catch(() => {
        /* ignore — fallback label stays as ticker */
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated, tickers, universe, universeByTicker, extraMeta]);

  // The LNB list = favorites projected onto the universe metadata. Tickers
  // that aren't in the AI-tracked universe still render with a placeholder
  // label so users can find them later (no signal dot, no live %).
  const favoriteItems: WatchlistItem[] = useMemo(() => {
    if (!hydrated) return [];
    return tickers.map((t) => {
      const hit = universeByTicker.get(t);
      const meta = extraMeta.get(t);
      // Prefer the resolved NAVER name when the universe row only has a
      // placeholder (== ticker). Otherwise keep the universe metadata
      // (signal dot, change %, sector, etc).
      if (hit) {
        const placeholder = hit.name === t || hit.name.trim() === '';
        return placeholder && meta
          ? {
              ...hit,
              name: meta.name,
              market: hit.market || meta.market,
              sector: hit.sector ?? meta.sector,
            }
          : hit;
      }
      return {
        ticker: t,
        name: meta?.name ?? t,
        market: meta?.market ?? '',
        sector: meta?.sector ?? null,
        signal: null,
        final_score: null,
        change_rate: null,
      } satisfies WatchlistItem;
    });
  }, [hydrated, tickers, universeByTicker, extraMeta]);

  const wrapperClass =
    variant === 'sheet'
      ? 'flex h-full flex-col w-full'
      : 'hidden md:flex flex-col w-[220px] shrink-0 border-r border-border-divider';

  const onWatchlistPage =
    pathname === '/watchlist' || pathname.startsWith('/watchlist/');

  return (
    <aside
      className={wrapperClass}
      style={{ background: 'var(--sidebar-bg)' }}
    >
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border-divider">
        <div className="h-7 w-7 sidebar-symbol" />
        <span className="font-heading text-base font-semibold tracking-tight">QuantSignal</span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {/* 관심주식 header — collapsible + add button. */}
        <div className="flex items-center gap-0.5 mx-2 px-1 h-9">
          <button
            type="button"
            onClick={() => setOpenSection((v) => !v)}
            aria-label={openSection ? '관심주식 접기' : '관심주식 펼치기'}
            className="p-1 rounded text-txt-muted hover:text-txt-primary hover:bg-[var(--sidebar-hover)] transition-colors"
          >
            {openSection ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <Link
            href="/watchlist"
            className={cn(
              'flex items-center gap-2 flex-1 px-1.5 h-8 rounded-sm text-sm transition-colors',
              onWatchlistPage
                ? 'bg-[var(--sidebar-active-bg)] text-brand-purple font-medium'
                : 'text-txt-secondary hover:text-txt-primary hover:bg-[var(--sidebar-hover)]',
            )}
          >
            <ListTodo className="h-4 w-4 shrink-0" />
            <span className="truncate">관심주식</span>
            {hydrated && (
              <span className="ml-auto text-[10px] text-txt-muted tabular-nums">
                {favoriteItems.length}
              </span>
            )}
          </Link>
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            aria-label="관심주식 추가"
            title="관심주식 추가"
            className="p-1 rounded text-txt-muted hover:text-brand-purple hover:bg-[var(--sidebar-hover)] transition-colors"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>

        {openSection && (
          <div className="mt-1 px-2">
            {!hydrated ? (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-txt-muted">
                <Loader2 className="h-3 w-3 animate-spin" />
                불러오는 중…
              </div>
            ) : favoriteItems.length === 0 ? (
              <div className="px-3 py-3 text-[11px] text-txt-muted">
                관심주식이 비어있습니다.
                <br />
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="mt-1 inline-flex items-center gap-1 text-brand-purple hover:underline"
                >
                  <Plus className="h-3 w-3" /> 종목 추가
                </button>
              </div>
            ) : (
              <ul className="space-y-px">
                {favoriteItems.map((it) => {
                  // KR tickers (6-char alphanumeric) → KR detail; everything
                  // else falls through to a generic stocks route.
                  const isKr = KR_TICKER_RE.test(it.ticker.toUpperCase());
                  const href = isKr
                    ? `/stocks/kr/${it.ticker}`
                    : `/stocks/${it.ticker.toLowerCase()}`;
                  const active = pathname === href;
                  const dot = signalColor(it.signal);
                  const pct = it.change_rate;
                  const pctCls =
                    pct == null
                      ? 'text-txt-muted'
                      : pct > 0
                        ? 'text-status-danger'
                        : pct < 0
                          ? 'text-status-info'
                          : 'text-txt-muted';
                  return (
                    <li key={it.ticker} className="group">
                      <div
                        className={cn(
                          'flex items-center gap-2 pl-6 pr-1 h-8 rounded-sm text-[12px] transition-colors',
                          active
                            ? 'bg-[var(--sidebar-active-bg)] text-brand-purple'
                            : 'text-txt-secondary hover:text-txt-primary hover:bg-[var(--sidebar-hover)]',
                        )}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full shrink-0"
                          style={{ background: dot }}
                          aria-hidden
                        />
                        <Link
                          href={href}
                          className="truncate flex-1"
                          title={`${it.name} (${it.ticker})${it.signal ? ` · ${it.signal}` : ''}`}
                        >
                          {it.name}
                        </Link>
                        {pct != null && (
                          <span className={cn('text-[10px] tabular-nums', pctCls)}>
                            {pct > 0 ? '+' : ''}
                            {(pct * 100).toFixed(1)}%
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => remove(it.ticker)}
                          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-txt-muted hover:text-status-danger transition-opacity"
                          aria-label={`${it.name} 제거`}
                          title="제거"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </nav>

      <div className="px-4 py-3 text-[10px] text-txt-muted border-t border-border-divider">
        <Layers3 className="inline h-3 w-3 mr-1" />
        v0.1 · 매매 권유 아님
      </div>

      <FavoritePicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        universe={universe}
        existing={tickers}
        onAdd={(t) => {
          add(t);
        }}
      />
    </aside>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Add-to-favorites picker

interface PickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universe: WatchlistItem[] | null;
  existing: string[];
  onAdd: (ticker: string) => void;
}

function FavoritePicker({ open, onOpenChange, universe, existing, onAdd }: PickerProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!universe) return [];
    const q = query.trim().toLowerCase();
    const base = q
      ? universe.filter(
          (it) =>
            it.name.toLowerCase().includes(q) ||
            it.ticker.toLowerCase().includes(q) ||
            (it.sector ?? '').toLowerCase().includes(q),
        )
      : universe;
    return base.slice(0, 100);
  }, [universe, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">관심주식 추가</DialogTitle>
        </DialogHeader>
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-txt-muted" />
            <Input
              autoFocus
              placeholder="종목명·티커·섹터 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8 h-9 text-sm"
            />
          </div>
        </div>
        <div className="max-h-[420px] overflow-y-auto border-t border-border-subtle">
          {universe === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              종목 목록 불러오는 중…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-8 text-center text-xs text-txt-muted">
              검색 결과가 없습니다.
            </div>
          ) : (
            <ul>
              {filtered.map((it) => {
                const added = existing.includes(it.ticker);
                return (
                  <li
                    key={it.ticker}
                    className="flex items-center gap-3 px-4 py-2 hover:bg-[var(--sidebar-hover)] border-b border-border-subtle/40 last:border-b-0"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full shrink-0"
                      style={{ background: signalColor(it.signal) }}
                      aria-hidden
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium truncate">{it.name}</span>
                        <span className="text-[10px] font-mono text-txt-muted">{it.ticker}</span>
                      </div>
                      <div className="text-[10px] text-txt-muted truncate">
                        {it.market}
                        {it.sector ? ` · ${it.sector}` : ''}
                        {it.signal ? ` · ${it.signal}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={added ? 'ghost' : 'outline'}
                      disabled={added}
                      onClick={() => onAdd(it.ticker)}
                      className="h-7 px-2 text-[11px]"
                    >
                      {added ? '추가됨' : (
                        <>
                          <Plus className="h-3 w-3 mr-0.5" />추가
                        </>
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="px-4 py-2 border-t border-border-subtle text-[10px] text-txt-muted text-right">
          {existing.length}개 추가됨
        </div>
      </DialogContent>
    </Dialog>
  );
}
