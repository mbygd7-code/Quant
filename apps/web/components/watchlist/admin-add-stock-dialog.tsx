'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { toast } from 'sonner';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  adminAddToWatchlist,
  searchUnaddedKrStocksAction,
} from '@/app/actions/watchlist';

interface SearchResult {
  ticker: string;
  name: string;
  sector: string | null;
  market: string;
}

/**
 * Admin-only dialog: search KR stocks NOT in the master watchlist and
 * add them. Distinct from the user-facing AddStockDialog (which writes
 * user_watchlists). This one toggles stocks.is_watchlist directly.
 */
export function AdminAddStockDialog({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pending, startTransition] = useTransition();
  const [hasSearched, setHasSearched] = useState(false);

  function runSearch(value: string) {
    setQuery(value);
    startTransition(async () => {
      const found = await searchUnaddedKrStocksAction(value);
      setResults(found);
      setHasSearched(true);
    });
  }

  async function handleAdd(ticker: string, name: string) {
    const res = await adminAddToWatchlist(ticker);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(`${name} 관심 종목 추가됨`);
    setOpen(false);
    setQuery('');
    setResults([]);
    setHasSearched(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o && !hasSearched) {
          // Pre-load 20 unadded KR stocks on open
          runSearch('');
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>관심 종목 추가 (Admin)</DialogTitle>
          <DialogDescription>
            stocks 마스터에 등록된 KR 종목 중 watchlist에 없는 것을 검색해 추가합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-muted" />
          <Input
            autoFocus
            placeholder="종목명 또는 6자리 티커..."
            value={query}
            onChange={(e) => runSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="max-h-72 overflow-y-auto space-y-1">
          {pending && <p className="text-xs text-txt-muted px-2">검색 중...</p>}
          {!pending && hasSearched && results.length === 0 && (
            <p className="text-xs text-txt-muted px-2">결과가 없습니다 (이미 모두 추가됐거나 stocks 마스터에 없음).</p>
          )}
          {results.map((r) => (
            <button
              key={r.ticker}
              type="button"
              onClick={() => handleAdd(r.ticker, r.name)}
              className="w-full text-left rounded-md border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 px-3 py-2 transition-colors"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{r.name}</span>
                <span className="text-[11px] font-mono text-txt-muted">{r.ticker}</span>
                <span className="ml-auto text-[11px] text-txt-secondary">
                  {r.sector ?? r.market}
                </span>
              </div>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>닫기</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
