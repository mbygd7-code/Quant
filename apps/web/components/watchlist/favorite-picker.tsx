'use client';

/**
 * Add-to-favorites picker dialog.
 *
 * Shared by the LNB Sidebar (+ button next to 관심주식) and the
 * /favorites page header (＋ 종목 추가). Two-tier search:
 *   1. Local — filters the AI-tracked universe (`/api/watchlist-list`).
 *   2. External — when local has < 5 matches, hits `/api/stocks/search`
 *      (NAVER autocomplete proxy) and offers to promote the picked stock
 *      into the master watchlist + favorites in one tap.
 *
 * The picker is intentionally stateless about its open/close; the parent
 * owns that. Parent also owns the universe fetch + revision-bumping so a
 * promoted external stock surfaces natively on next open.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Plus, Search } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { adminAddOrCreateStockAction } from '@/app/actions/watchlist';

export interface UniverseItem {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  signal: string | null;
}

interface ExternalHit {
  ticker: string;
  name: string;
  market: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universe: UniverseItem[] | null;
  existing: string[];
  /** Add to personal favorites (localStorage). */
  onAdd: (ticker: string) => void;
  /** Called after a stock is promoted into the master via external search. */
  onUniverseChanged?: () => void;
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

export function FavoritePicker({
  open,
  onOpenChange,
  universe,
  existing,
  onAdd,
  onUniverseChanged,
}: Props) {
  const [query, setQuery] = useState('');
  const [externalHits, setExternalHits] = useState<ExternalHit[]>([]);
  const [externalLoading, setExternalLoading] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);

  // Multi-select state. Two parallel sets so we can route each ticker to
  // the right handler on bulk-add (internal universe rows just call
  // onAdd, external hits also need a DB promote first).
  const [selectedInternal, setSelectedInternal] = useState<Set<string>>(new Set());
  const [selectedExternal, setSelectedExternal] = useState<Set<string>>(new Set());
  const [bulkAdding, setBulkAdding] = useState(false);

  const totalSelected = selectedInternal.size + selectedExternal.size;

  // Clear selection whenever the dialog is closed so re-opening starts fresh.
  useEffect(() => {
    if (!open) {
      setSelectedInternal(new Set());
      setSelectedExternal(new Set());
      setBulkAdding(false);
    }
  }, [open]);

  function toggleInternal(ticker: string) {
    setSelectedInternal((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  function toggleExternal(ticker: string) {
    setSelectedExternal((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) next.delete(ticker);
      else next.add(ticker);
      return next;
    });
  }

  // Drop a ticker from selection once it appears in `existing`. Catches the
  // race where the parent's optimistic add merges with a stock the user had
  // selected — we want the row to flip to "추가됨" cleanly.
  useEffect(() => {
    if (selectedInternal.size === 0) return;
    setSelectedInternal((prev) => {
      const next = new Set(prev);
      Array.from(prev).forEach((t) => {
        if (existing.includes(t)) next.delete(t);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [existing, selectedInternal.size]);

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

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || filtered.length >= 5) {
      setExternalHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setExternalLoading(true);
      try {
        const r = await fetch(`/api/stocks/search?q=${encodeURIComponent(q)}`, {
          cache: 'no-store',
        });
        const j = (await r.json()) as { items?: ExternalHit[] };
        if (cancelled) return;
        const inUniverse = new Set((universe ?? []).map((u) => u.ticker));
        setExternalHits(
          (j.items ?? []).filter((h) => !inUniverse.has(h.ticker)).slice(0, 15),
        );
      } catch {
        if (!cancelled) setExternalHits([]);
      } finally {
        if (!cancelled) setExternalLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, filtered.length, universe]);

  // Single-tap external promote (kept for direct-add use case below — not
  // used in multi-select mode, but small enough to keep).
  const promoteExternal = async (hit: ExternalHit) => {
    setPromoting(hit.ticker);
    try {
      const res = await adminAddOrCreateStockAction({
        ticker: hit.ticker,
        name: hit.name,
        market: (hit.market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI') as 'KOSPI' | 'KOSDAQ',
        sector: null,
      });
      if (res.error) {
        toast.error(`주식리스트 추가 실패: ${res.error}`);
        return;
      }
      onAdd(hit.ticker);
      onUniverseChanged?.();
      toast.success(`${hit.name} 주식리스트 + 관심주식 추가됨`);
    } finally {
      setPromoting(null);
    }
  };

  /**
   * Add every currently-selected ticker in one go. Internal universe rows
   * just call `onAdd`; external hits go through the DB promote first. We
   * run external promotes sequentially so a partial failure leaves a
   * useful toast trail; internal adds are synchronous & instant.
   */
  async function addSelected() {
    if (totalSelected === 0) return;
    setBulkAdding(true);
    try {
      // Internal — instant local-state updates.
      let added = 0;
      Array.from(selectedInternal).forEach((t) => {
        if (!existing.includes(t)) {
          onAdd(t);
          added += 1;
        }
      });

      // External — needs a DB row first.
      const externalToAdd = externalHits.filter((h) => selectedExternal.has(h.ticker));
      let externalAdded = 0;
      let externalFailed: string[] = [];
      for (const hit of externalToAdd) {
        try {
          const res = await adminAddOrCreateStockAction({
            ticker: hit.ticker,
            name: hit.name,
            market: (hit.market === 'KOSDAQ' ? 'KOSDAQ' : 'KOSPI') as 'KOSPI' | 'KOSDAQ',
            sector: null,
          });
          if (res.error) {
            externalFailed.push(hit.name);
            continue;
          }
          onAdd(hit.ticker);
          externalAdded += 1;
        } catch {
          externalFailed.push(hit.name);
        }
      }
      if (externalToAdd.length > 0) onUniverseChanged?.();

      const total = added + externalAdded;
      if (total > 0) toast.success(`관심주식 ${total}개 추가됨`);
      if (externalFailed.length > 0) {
        toast.error(`추가 실패: ${externalFailed.join(', ')}`);
      }
      // Close on full success; keep open if anything failed so user can retry.
      if (externalFailed.length === 0) onOpenChange(false);
      else {
        // Drop only the succeeded tickers from selection.
        setSelectedInternal(new Set());
        setSelectedExternal(
          new Set(externalToAdd.filter((h) => externalFailed.includes(h.name)).map((h) => h.ticker)),
        );
      }
    } finally {
      setBulkAdding(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden">
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
        <div className="max-h-[60vh] min-h-[420px] overflow-y-auto border-t border-border-subtle">
          {universe === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-txt-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              종목 목록 불러오는 중…
            </div>
          ) : filtered.length === 0 && externalHits.length === 0 && !externalLoading ? (
            <div className="py-8 text-center text-xs text-txt-muted">
              {query.trim().length >= 2
                ? '검색 결과가 없습니다.'
                : '검색어를 입력하세요.'}
            </div>
          ) : (
            <ul>
              {filtered.map((it) => {
                const added = existing.includes(it.ticker);
                const selected = selectedInternal.has(it.ticker);
                return (
                  <li key={it.ticker} className="border-b border-border-subtle/40 last:border-b-0">
                    <button
                      type="button"
                      disabled={added || bulkAdding}
                      onClick={() => !added && toggleInternal(it.ticker)}
                      className={
                        'w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ' +
                        (added
                          ? 'opacity-50 cursor-not-allowed'
                          : selected
                            ? 'bg-brand-purple/10 hover:bg-brand-purple/15'
                            : 'hover:bg-[var(--sidebar-hover)]')
                      }
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
                      <span
                        aria-hidden
                        className={
                          'h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ' +
                          (added
                            ? 'border-border-subtle bg-bg-tertiary/40 text-txt-muted'
                            : selected
                              ? 'border-brand-purple bg-brand-purple text-white'
                              : 'border-border-default bg-bg-secondary/40 text-transparent')
                        }
                      >
                        {added ? (
                          <Check className="h-3 w-3" />
                        ) : selected ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Plus className="h-3 w-3 text-txt-muted" />
                        )}
                      </span>
                      <span className="sr-only">{added ? '추가됨' : selected ? '선택됨' : '선택'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {(externalHits.length > 0 || externalLoading) && (
            <div className="border-t border-border-subtle">
              <div className="px-4 py-1.5 text-[10px] uppercase tracking-wider text-txt-muted bg-bg-tertiary/30">
                주식리스트에 없는 종목 (외부)
                {externalLoading && (
                  <Loader2 className="inline-block h-2.5 w-2.5 ml-1.5 animate-spin" />
                )}
              </div>
              <ul>
                {externalHits.map((hit) => {
                  const added = existing.includes(hit.ticker);
                  const selected = selectedExternal.has(hit.ticker);
                  return (
                    <li key={hit.ticker} className="border-b border-border-subtle/40 last:border-b-0">
                      <button
                        type="button"
                        disabled={added || bulkAdding}
                        onClick={() => !added && toggleExternal(hit.ticker)}
                        className={
                          'w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ' +
                          (added
                            ? 'opacity-50 cursor-not-allowed'
                            : selected
                              ? 'bg-brand-purple/10 hover:bg-brand-purple/15'
                              : 'hover:bg-[var(--sidebar-hover)]')
                        }
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full shrink-0 bg-border-default"
                          aria-hidden
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline gap-2">
                            <span className="text-sm font-medium truncate">{hit.name}</span>
                            <span className="text-[10px] font-mono text-txt-muted">{hit.ticker}</span>
                          </div>
                          <div className="text-[10px] text-txt-muted truncate">
                            {hit.market} · 추가 시 주식리스트에 자동 등록됩니다
                          </div>
                        </div>
                        <span
                          aria-hidden
                          className={
                            'h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ' +
                            (added
                              ? 'border-border-subtle bg-bg-tertiary/40 text-txt-muted'
                              : selected
                                ? 'border-brand-purple bg-brand-purple text-white'
                                : 'border-border-default bg-bg-secondary/40 text-transparent')
                          }
                        >
                          {added || selected ? (
                            <Check className="h-3 w-3" />
                          ) : (
                            <Plus className="h-3 w-3 text-txt-muted" />
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-border-subtle">
          <div className="text-[11px] text-txt-muted">
            {totalSelected > 0 ? (
              <span className="text-txt-primary font-medium">
                {totalSelected}개 선택됨
              </span>
            ) : (
              <>현재 {existing.length}개 추가됨 · 항목을 눌러 선택</>
            )}
          </div>
          <Button
            size="sm"
            onClick={addSelected}
            disabled={totalSelected === 0 || bulkAdding}
            className="h-8 px-3 text-xs"
          >
            {bulkAdding ? (
              <>
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                추가 중…
              </>
            ) : totalSelected > 0 ? (
              <>
                <Plus className="h-3 w-3 mr-1" />
                {totalSelected}개 추가
              </>
            ) : (
              <>
                <Plus className="h-3 w-3 mr-1" />
                추가
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
