import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { getQueryClient } from '@/lib/supabase/query-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BacktestForm } from '@/components/admin/backtest-form';

export const dynamic = 'force-dynamic';

export default async function BacktestPage() {
  const sb = await getQueryClient();

  const [{ data: weightConfigs }, { data: recentJobs }] = await Promise.all([
    sb.from('weight_configs').select('id, version, is_active').order('created_at', { ascending: false }),
    sb.from('backtest_jobs')
      .select('id, status, progress, params, created_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(10),
  ]);

  const configs = (weightConfigs ?? []) as Array<{ id: string; version: string; is_active: boolean }>;
  const jobs = (recentJobs ?? []) as Array<{
    id: string;
    status: string;
    progress: number | null;
    params: { start_date?: string; end_date?: string; strategy?: string } | null;
    created_at: string;
    completed_at: string | null;
  }>;

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">백테스트</h1>
        <p className="mt-1 text-sm text-txt-secondary">
          전략·기간·가중치 설정 → 비동기 실행 (DEV_BYPASS는 mock 모드로 즉시 완료)
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <BacktestForm weightConfigs={configs} />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">최근 백테스트</CardTitle>
          </CardHeader>
          <CardContent>
            {jobs.length === 0 ? (
              <p className="text-sm text-txt-secondary">아직 실행 기록이 없습니다.</p>
            ) : (
              <div className="space-y-2">
                {jobs.map((j) => (
                  <Link
                    key={j.id}
                    href={`/backtest/${j.id}`}
                    className="group flex items-center gap-3 rounded-md border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 px-3 py-2 transition-colors"
                  >
                    <StatusDot status={j.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 text-xs">
                        <span className="font-mono text-txt-primary">{j.params?.strategy ?? '—'}</span>
                        <span className="text-txt-muted truncate">
                          {j.params?.start_date} → {j.params?.end_date}
                        </span>
                      </div>
                      <div className="text-[10px] text-txt-muted">
                        {new Date(j.created_at).toLocaleString('ko-KR')} ·{' '}
                        <span className="capitalize">{j.status}</span>
                        {j.status === 'running' && j.progress != null && ` (${j.progress}%)`}
                      </div>
                    </div>
                    <ChevronRight className="h-3.5 w-3.5 text-txt-muted group-hover:text-txt-primary" />
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const tone =
    status === 'completed' ? 'bg-status-success'
    : status === 'failed' ? 'bg-status-error'
    : status === 'running' ? 'bg-brand-purple animate-breathe'
    : 'bg-txt-muted';
  return <span className={`h-2 w-2 rounded-full shrink-0 ${tone}`} />;
}
