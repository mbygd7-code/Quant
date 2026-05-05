import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getQueryClient } from '@/lib/supabase/query-client';
import { changeColor, formatPercent } from '@/lib/format';
import { BacktestResultCharts } from '@/components/admin/backtest-result-charts';

export const dynamic = 'force-dynamic';

interface BacktestResultRow {
  date: string;
  ticker: string;
  signal: string | null;
  actual_return: number | null;
  hit: boolean | null;
  entry_price: number | null;
  exit_price: number | null;
}

export default async function BacktestResultPage({
  params,
}: {
  params: Promise<{ job_id: string }>;
}) {
  const { job_id } = await params;
  const sb = await getQueryClient();

  const { data: job } = await sb
    .from('backtest_jobs')
    .select('*')
    .eq('id', job_id)
    .maybeSingle();
  if (!job) notFound();

  const params_ = (job.params as { start_date?: string; end_date?: string; strategy?: string }) || {};
  const { data: results } = await sb
    .from('backtest_results')
    .select('date, ticker, signal, actual_return, hit, entry_price, exit_price')
    .eq('strategy_id', params_.strategy ?? '')
    .gte('date', params_.start_date ?? '1900-01-01')
    .lte('date', params_.end_date ?? '9999-12-31')
    .order('date', { ascending: true });

  const trades = (results ?? []) as BacktestResultRow[];
  const nTrades = trades.length;
  const nHits = trades.filter((t) => t.hit).length;
  const winRate = nTrades > 0 ? nHits / nTrades : null;
  const cumReturn = trades.reduce((acc, t) => acc + (t.actual_return ?? 0), 0);

  // simple equity curve (cumulative sum of actual_return per date)
  const dailyReturns = trades.reduce<Map<string, number>>((acc, t) => {
    const v = (t.actual_return ?? 0) + (acc.get(t.date) ?? 0);
    acc.set(t.date, v);
    return acc;
  }, new Map());
  const equityCurve: { date: string; cum: number }[] = [];
  let running = 0;
  Array.from(dailyReturns.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([date, ret]) => {
      running += ret;
      equityCurve.push({ date, cum: running });
    });

  const bySignal: Record<string, { n: number; hits: number }> = {};
  trades.forEach((t) => {
    const k = t.signal ?? '(unknown)';
    bySignal[k] = bySignal[k] ?? { n: 0, hits: 0 };
    bySignal[k].n += 1;
    if (t.hit) bySignal[k].hits += 1;
  });
  const signalWinRate = Object.entries(bySignal).map(([signal, b]) => ({
    signal,
    winRate: b.n > 0 ? b.hits / b.n : 0,
    n: b.n,
  }));

  return (
    <div className="space-y-5 fade-in">
      <div>
        <Link href="/backtest" className="inline-flex items-center text-xs text-txt-muted hover:text-txt-primary">
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          백테스트 목록으로
        </Link>
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">백테스트 결과</h1>
        <Badge variant="outline" className="font-mono text-[11px]">{job_id.slice(0, 8)}</Badge>
        <Badge variant="outline">{params_.strategy}</Badge>
        <span className="text-sm text-txt-muted">
          {params_.start_date} → {params_.end_date}
        </span>
        <span className="ml-auto">
          {job.run_url && (
            <Button asChild variant="outline" size="sm">
              <a href={job.run_url as string} target="_blank" rel="noopener noreferrer">
                Actions 로그
                <ExternalLink className="h-3 w-3 ml-1" />
              </a>
            </Button>
          )}
        </span>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-txt-muted">누적 수익률</div>
            <div className={`mt-2 font-heading text-2xl font-semibold ${changeColor(cumReturn)}`}>
              {formatPercent(cumReturn)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-txt-muted">승률</div>
            <div className="mt-2 font-heading text-2xl font-semibold">
              {winRate != null ? `${(winRate * 100).toFixed(1)}%` : '—'}
            </div>
            <div className="text-[11px] text-txt-muted">{nHits} / {nTrades}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-txt-muted">거래 수</div>
            <div className="mt-2 font-heading text-2xl font-semibold tabular-nums">{nTrades}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-txt-muted">상태</div>
            <div className="mt-2 text-sm font-medium capitalize">
              {job.status as string}
            </div>
            {job.completed_at && (
              <div className="text-[11px] text-txt-muted">
                {new Date(job.completed_at as string).toLocaleString('ko-KR')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {trades.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            거래 결과가 비어있습니다. 백테스트가 mock 모드로 즉시 완료됐거나 강건성 검증 후 결과가 저장되지 않은 상태입니다.
          </CardContent>
        </Card>
      ) : (
        <BacktestResultCharts equityCurve={equityCurve} signalWinRate={signalWinRate} />
      )}

      {trades.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">일별 거래 (최근 50건)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-border bg-bg-secondary/60 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="text-txt-muted border-b border-border">
                  <tr>
                    <th className="text-left p-2">날짜</th>
                    <th className="text-left p-2">티커</th>
                    <th className="text-left p-2">신호</th>
                    <th className="text-right p-2">진입가</th>
                    <th className="text-right p-2">청산가</th>
                    <th className="text-right p-2">수익률</th>
                    <th className="text-right p-2">적중</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.slice(0, 50).map((t, i) => (
                    <tr key={i} className="border-b border-border-divider-faint">
                      <td className="p-2 font-mono">{t.date}</td>
                      <td className="p-2 font-mono">{t.ticker}</td>
                      <td className="p-2">{t.signal ?? '—'}</td>
                      <td className="p-2 text-right tabular-nums">{t.entry_price?.toLocaleString('ko-KR') ?? '—'}</td>
                      <td className="p-2 text-right tabular-nums">{t.exit_price?.toLocaleString('ko-KR') ?? '—'}</td>
                      <td className={`p-2 text-right tabular-nums ${changeColor(t.actual_return)}`}>
                        {formatPercent(t.actual_return)}
                      </td>
                      <td className="p-2 text-right">{t.hit ? '✓' : '✗'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {trades.length > 50 && (
              <p className="mt-2 text-[11px] text-txt-muted">+ {trades.length - 50}건 더 있음</p>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
