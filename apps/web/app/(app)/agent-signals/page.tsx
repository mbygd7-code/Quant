import { Activity, ArrowDownRight, ArrowUpRight, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { gradeBand } from '@/lib/agents/grade';
import { type SignalGrade } from '@/lib/agents/types';
import { cn } from '@/lib/utils';
import { getQueryClient } from '@/lib/supabase/query-client';

export const dynamic = 'force-dynamic';

interface FinalSignalRow {
  id: string;
  ticker: string;
  cycle_at: string;
  signal_grade: SignalGrade;
  confidence: number | null;
  weighted_score: number | null;
  narrative: string;
  taleb_severity: number | null;
  taleb_override: boolean;
  weights_snapshot: Record<string, unknown>;
}

interface ChangeEventRow {
  id: string;
  ticker: string;
  from_grade: SignalGrade | null;
  to_grade: SignalGrade;
  reason: string;
  created_at: string;
  notified_at: string | null;
}

interface StockRow {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
}

const TONE_CLASS: Record<string, string> = {
  success: 'border-status-success/40 text-status-success',
  positive: 'border-brand-purple/40 text-brand-purple',
  neutral: 'border-border-divider text-txt-secondary',
  warning: 'border-status-warning/40 text-status-warning',
  danger: 'border-status-danger/40 text-status-danger',
};

function formatScore(n: number | null): string {
  if (n == null) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
}

function formatTime(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

export default async function AgentSignalsPage() {
  const sb = await getQueryClient();

  // Latest final_signals per ticker. We pull the last 14 days then
  // group client-side to grab the newest per ticker — simpler than
  // a Postgres DISTINCT-ON query through PostgREST.
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const [signalsRes, changesRes, stocksRes] = await Promise.all([
    sb
      .from('final_signals')
      .select('*')
      .gte('cycle_at', since)
      .order('cycle_at', { ascending: false })
      .limit(500),
    sb
      .from('signal_change_events')
      .select('*')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(50),
    sb.from('stocks').select('ticker, name, market, sector'),
  ]);

  const allSignals = (signalsRes.data ?? []) as FinalSignalRow[];
  const changes = (changesRes.data ?? []) as ChangeEventRow[];
  const stocks = (stocksRes.data ?? []) as StockRow[];
  const stocksByTicker = new Map(stocks.map((s) => [s.ticker, s]));

  // Newest final_signal per ticker.
  const latestByTicker = new Map<string, FinalSignalRow>();
  for (const sig of allSignals) {
    if (!latestByTicker.has(sig.ticker)) latestByTicker.set(sig.ticker, sig);
  }
  const latest = Array.from(latestByTicker.values()).sort((a, b) => {
    // Sort by signal_grade severity (STRONG_BUY first, RISK last) then
    // by score descending so the most actionable rows surface up top.
    const order: Record<SignalGrade, number> = {
      STRONG_BUY: 0,
      BUY: 1,
      HOLD: 2,
      CAUTION: 3,
      RISK: 4,
    };
    if (order[a.signal_grade] !== order[b.signal_grade]) {
      return order[a.signal_grade] - order[b.signal_grade];
    }
    return (b.weighted_score ?? 0) - (a.weighted_score ?? 0);
  });

  return (
    <div className="space-y-5 fade-in">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          AI 시그널
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          M2 단계: <strong>Graham</strong>(가치) + <strong>Dow</strong>(추세)의 종합을{' '}
          <strong>Soros</strong>가 5등급 시그널로 변환합니다. 매일 07:00 / 12:00 /
          16:00 KST 자동 갱신.
        </p>
      </header>

      {/* Recent change events */}
      {changes.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Activity className="h-4 w-4 text-brand-purple" />
              최근 시그널 변경 ({changes.length})
            </div>
            <div className="space-y-1">
              {changes.slice(0, 10).map((evt) => {
                const stock = stocksByTicker.get(evt.ticker);
                const fromBand = evt.from_grade
                  ? gradeBand(evt.from_grade)
                  : null;
                const toBand = gradeBand(evt.to_grade);
                const isUpgrade =
                  evt.from_grade != null &&
                  rankOf(evt.from_grade) > rankOf(evt.to_grade);
                const isDowngrade =
                  evt.from_grade != null &&
                  rankOf(evt.from_grade) < rankOf(evt.to_grade);
                return (
                  <div
                    key={evt.id}
                    className="flex items-center justify-between gap-3 text-sm border-b border-border-subtle py-1.5 last:border-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {isUpgrade ? (
                        <ArrowUpRight className="h-3.5 w-3.5 text-status-success shrink-0" />
                      ) : isDowngrade ? (
                        <ArrowDownRight className="h-3.5 w-3.5 text-status-danger shrink-0" />
                      ) : (
                        <Clock className="h-3.5 w-3.5 text-txt-muted shrink-0" />
                      )}
                      <span className="truncate font-medium">
                        {stock?.name ?? evt.ticker}
                      </span>
                      <span className="font-mono text-[10px] text-txt-muted shrink-0">
                        {evt.ticker}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {fromBand && (
                        <Badge
                          variant="outline"
                          className={cn(TONE_CLASS[fromBand.tone], 'text-[10px]')}
                        >
                          {fromBand.label}
                        </Badge>
                      )}
                      <span className="text-txt-muted">→</span>
                      <Badge
                        variant="outline"
                        className={cn(TONE_CLASS[toBand.tone], 'text-[10px]')}
                      >
                        {toBand.label}
                      </Badge>
                      <span className="text-[11px] text-txt-muted ml-2 hidden sm:inline">
                        {formatTime(evt.created_at)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Latest signal per ticker */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-txt-muted border-b border-border-divider">
                <th className="px-4 py-2">종목</th>
                <th className="px-4 py-2">시그널</th>
                <th className="px-4 py-2 text-right">점수</th>
                <th className="px-4 py-2 text-right">신뢰도</th>
                <th className="px-4 py-2">분석가 종합</th>
                <th className="px-4 py-2 text-right hidden md:table-cell">갱신</th>
              </tr>
            </thead>
            <tbody>
              {latest.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-xs text-txt-muted"
                  >
                    final_signals에 적재된 행이 없습니다. M2 첫 사이클이 돌면
                    자동 채워집니다 (cron: 07/12/16 KST).
                  </td>
                </tr>
              )}
              {latest.map((sig) => {
                const stock = stocksByTicker.get(sig.ticker);
                const band = gradeBand(sig.signal_grade);
                return (
                  <tr key={sig.id} className="border-b border-border-subtle">
                    <td className="px-4 py-2">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <span className="font-medium truncate">
                          {stock?.name ?? sig.ticker}
                        </span>
                        <span className="text-[10px] font-mono text-txt-muted shrink-0">
                          {sig.ticker}
                        </span>
                        {stock?.market && (
                          <Badge
                            variant="outline"
                            className="h-4 px-1.5 text-[9px] font-normal shrink-0"
                          >
                            {stock.market}
                          </Badge>
                        )}
                      </div>
                      <div className="text-[11px] text-txt-muted mt-0.5">
                        {stock?.sector ?? '—'}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <Badge
                        variant="outline"
                        className={cn(TONE_CLASS[band.tone])}
                      >
                        {band.label}
                      </Badge>
                      {sig.taleb_override && (
                        <Badge
                          variant="outline"
                          className="ml-1 border-status-danger/40 text-status-danger text-[10px]"
                        >
                          Taleb 강제 ↓
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-mono">
                      {formatScore(sig.weighted_score)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {sig.confidence != null
                        ? `${(sig.confidence * 100).toFixed(0)}%`
                        : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-txt-secondary max-w-md">
                      <p className="line-clamp-2">{sig.narrative}</p>
                    </td>
                    <td className="px-4 py-2 text-right hidden md:table-cell text-[11px] text-txt-muted">
                      {formatTime(sig.cycle_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-txt-muted">
        ※ M2는 Graham + Dow 두 분석가만 활용합니다. M3 이후 Shiller·Keynes,
        M4 Taleb, M5 Simons가 합류하면 종합 정확도가 향상됩니다. 본 정보는 매매
        권유가 아닙니다.
      </p>
    </div>
  );
}

function rankOf(g: SignalGrade): number {
  return { STRONG_BUY: 0, BUY: 1, HOLD: 2, CAUTION: 3, RISK: 4 }[g];
}
