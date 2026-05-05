'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

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
import { SignalBadge } from '@/components/signals/signal-badge';
import { changeColor, formatPercent, formatPrice, formatScore } from '@/lib/format';
import type { WatchlistRow } from '@/lib/queries/watchlist';

interface Props {
  rows: WatchlistRow[];
  date: string;
}

export function WatchlistTable({ rows, date }: Props) {
  const [query, setQuery] = useState('');
  const [sector, setSector] = useState<string>('all');

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
              <TableHead className="w-[28%]">종목</TableHead>
              <TableHead className="w-[12%]">섹터</TableHead>
              <TableHead className="w-[14%]">신호</TableHead>
              <TableHead className="w-[10%] text-right">점수</TableHead>
              <TableHead className="w-[18%] text-right">종가 / 등락</TableHead>
              <TableHead className="w-[18%] text-right">상세</TableHead>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
