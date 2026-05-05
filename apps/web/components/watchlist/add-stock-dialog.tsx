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
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { addStockToWatchlist, searchStocksAction } from '@/app/actions/watchlist';

interface Props {
  children: React.ReactNode;
  currentCount: number;
  limit: number;
}

interface SearchResult {
  ticker: string;
  name: string;
  sector: string | null;
  market: string;
}

export function AddStockDialog({ children, currentCount, limit }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pending, startTransition] = useTransition();
  const remaining = limit - currentCount;

  function handleSearch(value: string) {
    setQuery(value);
    if (value.trim().length < 1) {
      setResults([]);
      return;
    }
    startTransition(async () => {
      const found = await searchStocksAction(value);
      setResults(found);
    });
  }

  async function handleAdd(ticker: string) {
    if (remaining <= 0) {
      toast.error(`종목 한도(${limit}개)에 도달했습니다`);
      return;
    }
    const res = await addStockToWatchlist(ticker);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success('관심 종목에 추가됐습니다');
    setOpen(false);
    setQuery('');
    setResults([]);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>종목 추가</DialogTitle>
          <DialogDescription>
            남은 슬롯 {remaining} / {limit}
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-txt-muted" />
          <Input
            autoFocus
            placeholder="종목명 또는 티커..."
            value={query}
            onChange={(e) => handleSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <div className="max-h-72 overflow-y-auto space-y-1">
          {pending && <p className="text-xs text-txt-muted px-2">검색 중...</p>}
          {!pending && query && results.length === 0 && (
            <p className="text-xs text-txt-muted px-2">결과가 없습니다.</p>
          )}
          {results.map((r) => (
            <button
              key={r.ticker}
              type="button"
              onClick={() => handleAdd(r.ticker)}
              className="w-full text-left rounded-md border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 px-3 py-2 transition-colors"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-medium">{r.name}</span>
                <span className="text-[11px] font-mono text-txt-muted">{r.ticker}</span>
                <span className="ml-auto text-[11px] text-txt-secondary">{r.sector ?? r.market}</span>
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>닫기</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
