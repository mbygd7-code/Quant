'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fetchJobStatus, startBacktest } from '@/app/(admin)/backtest/actions';

const STRATEGIES = [
  { value: 'score_above_065', label: '점수 ≥ 0.65 (관심+)' },
  { value: 'strong_only', label: '강한 관심만' },
  { value: 'top5_per_day', label: '일별 상위 5종목' },
] as const;

interface WeightConfig {
  id: string;
  version: string;
  is_active: boolean;
}

export function BacktestForm({ weightConfigs }: { weightConfigs: WeightConfig[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const [startDate, setStartDate] = useState(monthAgo);
  const [endDate, setEndDate] = useState(today);
  const [strategy, setStrategy] = useState<'score_above_065' | 'strong_only' | 'top5_per_day'>('score_above_065');
  const activeWeight = weightConfigs.find((c) => c.is_active)?.id ?? weightConfigs[0]?.id ?? '';
  const [weightId, setWeightId] = useState(activeWeight);

  const [activeJob, setActiveJob] = useState<{
    id: string;
    status: string;
    progress: number | null;
    error: string | null;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  function startPolling(jobId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const job = await fetchJobStatus(jobId);
      if (!job) return;
      setActiveJob({
        id: job.id as string,
        status: job.status as string,
        progress: (job.progress as number | null) ?? null,
        error: (job.error as string | null) ?? null,
      });
      if (job.status === 'completed' || job.status === 'failed') {
        if (pollRef.current) clearInterval(pollRef.current);
        if (job.status === 'completed') {
          toast.success('백테스트 완료 — 결과 페이지로 이동');
          router.push(`/backtest/${jobId}`);
        } else {
          toast.error(`백테스트 실패: ${job.error ?? 'unknown'}`);
        }
      }
    }, 2000);
  }

  function handleSubmit() {
    if (new Date(startDate) >= new Date(endDate)) {
      toast.error('시작일이 종료일보다 빠르지 않습니다');
      return;
    }
    startTransition(async () => {
      const res = await startBacktest({
        start_date: startDate,
        end_date: endDate,
        strategy,
        weight_config_id: weightId || null,
      });
      if (res.error) {
        toast.error(`실행 실패: ${res.error}`);
        return;
      }
      if (!res.job_id) return;

      if (res.mode === 'mock') {
        toast.success('Mock 모드 — 즉시 완료. 결과 페이지로 이동');
        router.push(`/backtest/${res.job_id}`);
        return;
      }

      setActiveJob({ id: res.job_id, status: 'queued', progress: 0, error: null });
      toast.success('실행 요청됨 — 진행 상황 폴링 중');
      startPolling(res.job_id);
    });
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-heading">새 백테스트</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="start_date">시작일</Label>
            <Input
              id="start_date"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="apple-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="end_date">종료일</Label>
            <Input
              id="end_date"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="apple-input"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>전략</Label>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as typeof strategy)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {weightConfigs.length > 0 && (
          <div className="space-y-1.5">
            <Label>가중치 버전</Label>
            <Select value={weightId} onValueChange={setWeightId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {weightConfigs.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    v{c.version}{c.is_active ? ' · active' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <Button
          className="w-full bg-gradient-brand text-white"
          onClick={handleSubmit}
          disabled={pending || !!activeJob}
        >
          {pending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FlaskConical className="h-4 w-4 mr-1" />}
          {pending ? '요청 중...' : '실행'}
        </Button>

        {activeJob && (
          <div className="rounded-md border border-brand-purple/30 bg-brand-purple/5 p-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-txt-primary" />
              <span className="font-mono text-xs">{activeJob.id.slice(0, 8)}</span>
              <span className="ml-auto text-xs uppercase tracking-wider text-txt-primary">
                {activeJob.status} {activeJob.progress != null && `(${activeJob.progress}%)`}
              </span>
            </div>
            <div className="mt-2 h-1.5 rounded-full bg-bg-tertiary overflow-hidden">
              <div
                className="h-full bg-gradient-brand transition-all"
                style={{ width: `${activeJob.progress ?? 0}%` }}
              />
            </div>
            {activeJob.error && (
              <p className="mt-2 text-xs text-status-error">{activeJob.error}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
