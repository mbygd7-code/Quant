import { Badge } from '@/components/ui/badge';
import { changeColor, formatPercent } from '@/lib/format';

interface MarketRow {
  symbol: string;
  change_rate: number | null;
  close: number | null;
}

interface ScoreRow {
  ticker: string;
  signal: string | null;
  final_score: number;
  stocks: { name: string | null; sector: string | null } | null;
}

export function DryRunPreview({
  market,
  top5,
}: {
  market: MarketRow[];
  top5: ScoreRow[];
}) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="rounded-lg border border-border bg-bg-tertiary/40 p-3 space-y-3">
      <div className="rounded-md bg-bg-primary/60 px-3 py-2 text-xs text-txt-muted">
        🤖 QuantSignal Bot · {today}
      </div>
      <div className="space-y-2 text-xs">
        <div className="font-medium">📊 글로벌 온도</div>
        <div className="space-y-0.5">
          {market.length === 0 ? (
            <p className="text-txt-muted">데이터 없음</p>
          ) : (
            market.map((m) => (
              <div key={m.symbol} className="flex items-center gap-2">
                <span className="font-mono w-12">{m.symbol}</span>
                <span className={`font-mono ${changeColor(m.change_rate)}`}>
                  {formatPercent(m.change_rate)}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="border-t border-border-divider-faint pt-2" />
        <div className="font-medium">🟣 강한 관심 Top 5</div>
        <div className="space-y-1">
          {top5.length === 0 ? (
            <p className="text-txt-muted">아직 점수 데이터 없음</p>
          ) : (
            top5.map((t) => (
              <div key={t.ticker} className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px]">{t.signal ?? '—'}</Badge>
                <span className="truncate flex-1">{t.stocks?.name ?? t.ticker}</span>
                <span className="font-mono text-[10px] text-txt-muted">{t.ticker}</span>
                <span className="font-mono">{t.final_score.toFixed(2)}</span>
              </div>
            ))
          )}
        </div>
        <div className="pt-2 text-[10px] text-txt-muted italic">
          본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
        </div>
      </div>
    </div>
  );
}
