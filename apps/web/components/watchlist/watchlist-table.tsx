'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SignalBadge } from '@/components/signals/signal-badge';
import { changeColor, formatPercent, formatPrice, formatScore } from '@/lib/format';
import type { WatchlistRow } from '@/lib/queries/watchlist';
import {
  adminRemoveFromWatchlist,
  removeStockFromWatchlist,
} from '@/app/actions/watchlist';
import type { Role } from '@/lib/types';

interface Props {
  rows: WatchlistRow[];
  date: string;
  role: Role;
}

const FAVORITES_KEY = 'qs:favorites:v1';

export function WatchlistTable({ rows, date, role }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState<string>('all');
  const [confirmRemove, setConfirmRemove] = useState<WatchlistRow | null>(null);
  const [pending, startTransition] = useTransition();
  const canEdit = role === 'admin' || role === 'beta' || role === 'user';
  const isAdmin = role === 'admin';

  // Personal favorites — synced with the LNB Sidebar (same localStorage key).
  // Keep an in-component Set so re-renders are O(1) lookups.
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FAVORITES_KEY);
      if (raw) setFavorites(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore corrupt storage */
    }
    // Listen for other tabs / Sidebar updates so adds elsewhere reflect here.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== FAVORITES_KEY) return;
      try {
        setFavorites(new Set(JSON.parse(e.newValue ?? '[]') as string[]));
      } catch {
        setFavorites(new Set());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const toggleFavorite = useCallback(
    (ticker: string, name: string) => {
      // IMPORTANT: side effects (localStorage write, dispatchEvent, toast) must
      // live OUTSIDE the setState updater — React strict mode runs updaters
      // twice in dev, which would toggle the value back to its original state.
      // We read once from localStorage to know the canonical previous set.
      let prev: string[] = [];
      try {
        prev = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]') as string[];
      } catch {
        /* corrupt — treat as empty */
      }
      const wasIn = prev.includes(ticker);
      const next = wasIn ? prev.filter((t) => t !== ticker) : [...prev, ticker];
      try {
        localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
        window.dispatchEvent(
          new StorageEvent('storage', {
            key: FAVORITES_KEY,
            newValue: JSON.stringify(next),
          }),
        );
      } catch {
        /* over quota — silent */
      }
      setFavorites(new Set(next));
      toast.success(wasIn ? `${name} 관심주식에서 제거` : `${name} 관심주식 추가됨`);
    },
    [],
  );

  const sectors = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => r.sector && set.add(r.sector));
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (sector !== 'all' && r.sector !== sector) return false;
      if (!q) return true;
      return (
        r.ticker.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.sector ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, query, sector]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="종목명, 티커, 섹터 검색..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <Select value={sector} onValueChange={setSector}>
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="섹터" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 섹터</SelectItem>
            {sectors.map((s) => (
              <SelectItem key={s} value={s}>{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-txt-muted">{filtered.length} / {rows.length}</span>
      </div>

      <div className="rounded-md border border-border overflow-hidden bg-bg-secondary/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[26%]">종목</TableHead>
              <TableHead className="w-[10%]">섹터</TableHead>
              <TableHead className="w-[12%]">신호</TableHead>
              <TableHead className="w-[8%] text-right">점수</TableHead>
              <TableHead className="w-[16%] text-right">종가 / 등락</TableHead>
              <TableHead className="w-[14%] text-right">상세</TableHead>
              <TableHead className="w-[12%] text-right">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.ticker}>
                <TableCell>
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{r.name}</span>
                    <span className="text-[11px] font-mono text-txt-muted">{r.ticker}</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-txt-secondary">{r.sector ?? '—'}</TableCell>
                <TableCell><SignalBadge signal={r.signal} /></TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatScore(r.final_score)}
                </TableCell>
                <TableCell className={`text-right font-mono tabular-nums ${changeColor(r.change_rate)}`}>
                  {formatPrice(r.close)}{' '}
                  <span className="text-[11px]">{formatPercent(r.change_rate)}</span>
                </TableCell>
                <TableCell className="text-right">
                  {date ? (
                    <Link
                      href={`/reports/${date}/${r.ticker}`}
                      className="text-brand-purple hover:underline text-xs"
                    >
                      자세히 →
                    </Link>
                  ) : (
                    <span className="text-xs text-txt-muted">—</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title={favorites.has(r.ticker) ? '관심주식에서 제거' : '관심주식에 추가'}
                      onClick={() => toggleFavorite(r.ticker, r.name)}
                      aria-pressed={favorites.has(r.ticker)}
                    >
                      <Star
                        className={
                          'h-3.5 w-3.5 ' +
                          (favorites.has(r.ticker)
                            ? 'fill-status-warning text-status-warning'
                            : 'text-txt-muted')
                        }
                      />
                    </Button>
                    {canEdit && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="시스템 마스터에서 제거"
                        onClick={() => setConfirmRemove(r)}
                        disabled={pending}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-status-error" />
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!confirmRemove} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>관심 종목에서 제거</DialogTitle>
            <DialogDescription>
              {confirmRemove && (
                <>
                  <strong>{confirmRemove.name}</strong> ({confirmRemove.ticker})
                  {isAdmin
                    ? '를 시스템 관심 종목 마스터에서 제거합니다. 종목 마스터 자체는 유지되며 is_watchlist=false로 변경됩니다.'
                    : '를 본인 관심 종목 목록에서 제거합니다.'}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(null)}>취소</Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                if (!confirmRemove) return;
                const ticker = confirmRemove.ticker;
                const name = confirmRemove.name;
                startTransition(async () => {
                  const res = isAdmin
                    ? await adminRemoveFromWatchlist(ticker)
                    : await removeStockFromWatchlist(ticker);
                  if (res.error) toast.error(`제거 실패: ${res.error}`);
                  else {
                    toast.success(`${name} 제거됨`);
                    router.refresh();
                  }
                  setConfirmRemove(null);
                });
              }}
            >
              {pending ? '제거 중...' : '제거'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
