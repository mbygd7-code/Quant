import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { changeColor, formatPercent } from '@/lib/format';

interface Props {
  symbol: string;
  label: string;
  close: number | null;
  changeRate: number | null;
}

export function MarketTempCard({ symbol, label, close, changeRate }: Props) {
  const Arrow = changeRate == null ? Minus : changeRate > 0 ? ArrowUp : changeRate < 0 ? ArrowDown : Minus;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-[11px] uppercase tracking-wider text-txt-muted">{symbol}</div>
        <div className="mt-0.5 text-sm font-sub text-txt-secondary truncate">{label}</div>
        <div className={`mt-2 flex items-baseline gap-1.5 font-heading text-xl font-semibold ${changeColor(changeRate)}`}>
          <Arrow className="h-4 w-4" />
          <span>{formatPercent(changeRate)}</span>
        </div>
        <div className="mt-1 text-xs text-txt-muted">
          {close != null ? close.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '—'}
        </div>
      </CardContent>
    </Card>
  );
}
