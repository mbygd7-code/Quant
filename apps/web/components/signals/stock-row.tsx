import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { SignalBadge } from './signal-badge';
import { changeColor, formatPercent, formatPrice, formatScore } from '@/lib/format';
import type { Signal } from '@/lib/types';

interface Props {
  date: string;
  ticker: string;
  name: string;
  sector: string | null;
  signal: Signal | null;
  finalScore: number | null;
  changeRate: number | null;
  close: number | null;
}

export function StockRow({
  date, ticker, name, sector, signal, finalScore, changeRate, close,
}: Props) {
  return (
    <Link
      href={`/reports/${date}/${ticker}`}
      className="group flex items-center gap-3 px-3 py-2.5 rounded-md border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 hover:border-hover-strong transition-colors"
    >
      <SignalBadge signal={signal} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-txt-primary truncate">{name}</span>
          <span className="text-[11px] font-mono text-txt-muted shrink-0">{ticker}</span>
        </div>
        <div className="text-[11px] text-txt-muted truncate">{sector ?? '—'}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-sm tabular-nums text-txt-primary">{formatScore(finalScore)}</div>
        <div className={`font-mono text-[11px] tabular-nums ${changeColor(changeRate)}`}>
          {formatPrice(close)} {formatPercent(changeRate)}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-txt-muted group-hover:text-txt-primary shrink-0" />
    </Link>
  );
}
