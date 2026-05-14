import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { gradeToLabel, type SignalGrade } from '@/lib/signal-resolver';
import type { VoterBreakdown } from '@/lib/queries/voters';

const VOTER_LABELS: Record<string, { name: string; angle: string }> = {
  graham:  { name: 'Graham',  angle: '가치 (PE/PBR · ROE)' },
  dow:     { name: 'Dow',     angle: '추세 (이평선 정렬)' },
  turing:  { name: 'Turing',  angle: '기술 (RSI · MACD · BB)' },
  shiller: { name: 'Shiller', angle: '사이클 (PER · 매출 추세)' },
  keynes:  { name: 'Keynes',  angle: '거시 (USD/금리/VIX · 베타)' },
  taleb:   { name: 'Taleb',   angle: '리스크 (꼬리위험 · 이벤트)' },
  simons:  { name: 'Simons',  angle: 'ML (GBM 예측)' },
};

function voterColor(score: number): string {
  // Mirror SIGNAL_TONE so a +1.2 voter reads the same color as 강한관심 etc.
  if (score >= 1.0)   return 'rgb(72,166,152)';   // success
  if (score >= 0.3)   return '#7CC97E';
  if (score >= -0.3)  return 'rgb(170,170,170)';
  if (score >= -1.0)  return '#E9B247';
  return 'rgb(220,72,72)';
}

export function VoterBreakdownCard({ data }: { data: VoterBreakdown }) {
  const grade = data.signal_grade as SignalGrade;
  const label = gradeToLabel(grade);
  const weights = data.weights_snapshot ?? {};

  return (
    <Card className="border-brand-purple/20">
      <CardHeader>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-base font-heading flex items-center gap-2">
            <span className="inline-block h-6 w-6 rounded-full bg-gradient-brand" />
            6-Voter 합의
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-txt-muted">
            <span>cycle: <span className="font-mono">{data.cycle_at.slice(0, 16).replace('T', ' ')}</span></span>
            {data.taleb_override && (
              <Badge variant="outline" className="border-status-danger/40 text-status-danger">
                Taleb override (sev {data.taleb_severity})
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Header: weighted score + grade + confidence */}
        <div className="flex flex-wrap items-baseline gap-3 text-sm">
          <span className="text-txt-muted">최종 등급</span>
          <span className="font-semibold text-brand-purple text-base">{label}</span>
          <span className="text-txt-muted ml-3">가중 점수</span>
          <span className="font-mono tabular-nums">
            {data.weighted_score != null ? data.weighted_score.toFixed(2) : '—'}
          </span>
          {data.confidence != null && (
            <>
              <span className="text-txt-muted ml-3">voter 합의</span>
              <span
                className={cn(
                  'font-mono tabular-nums',
                  data.confidence < 0.5 && 'text-status-warning',
                  data.confidence >= 0.7 && 'text-status-success',
                )}
              >
                {Math.round(data.confidence * 100)}%
              </span>
            </>
          )}
        </div>

        {/* Low-confidence warning — when voters disagree the grade
            could swing on the next cron. Surface this prominently so
            users don't treat a low-confidence call like a high-confidence
            one. */}
        {data.confidence != null && data.confidence < 0.5 && (
          <div className="rounded-md border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
            ⚠ voter 의견이 분산되어 있습니다 ({Math.round(data.confidence * 100)}%). 단일
            voter가 신호를 주도하므로 다음 사이클 갱신을 함께 확인하세요.
          </div>
        )}

        {/* Per-voter bars — score on a -2..+2 axis, half-width = 0. */}
        <div className="space-y-2">
          {data.voters.map((v) => {
            const meta = VOTER_LABELS[v.agent_name] ?? {
              name: v.agent_name,
              angle: '',
            };
            const weight = weights[v.agent_name];
            const widthPct = Math.min(100, (Math.abs(v.score) / 2) * 50); // 50 = half axis
            return (
              <div key={v.agent_name} className="space-y-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className="font-medium w-16 shrink-0">{meta.name}</span>
                  <span className="text-txt-muted flex-1 truncate">{meta.angle}</span>
                  {weight != null && (
                    <span className="text-[10px] text-txt-muted tabular-nums">
                      w {Math.round(weight * 100)}%
                    </span>
                  )}
                  <span
                    className="font-mono tabular-nums w-14 text-right"
                    style={{ color: voterColor(v.score) }}
                  >
                    {v.score >= 0 ? '+' : ''}
                    {v.score.toFixed(2)}
                  </span>
                </div>
                {/* Bar — centered axis with the voter score extending left or right. */}
                <div className="relative h-1.5 rounded-full bg-bg-tertiary/40 overflow-hidden">
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-default/60" />
                  <div
                    className={cn(
                      'absolute top-0 bottom-0 transition-all',
                      v.score >= 0 ? 'left-1/2' : 'right-1/2',
                    )}
                    style={{ width: `${widthPct}%`, background: voterColor(v.score) }}
                  />
                </div>
                {v.narrative && (
                  <p className="text-[11px] text-txt-secondary line-clamp-2 pl-[68px]">
                    {v.narrative}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Soros synthesis narrative */}
        {data.narrative && (
          <div className="rounded-md border border-brand-purple/20 bg-brand-purple/5 p-3">
            <div className="text-[10px] uppercase tracking-wider text-brand-purple mb-1">
              Soros 종합
            </div>
            <p className="text-sm text-txt-primary whitespace-pre-line">
              {data.narrative}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
