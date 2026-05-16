import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getQueryClient } from '@/lib/supabase/query-client';
import { DailyMetricsLine } from '@/components/admin/daily-metrics-line';

export const dynamic = 'force-dynamic';

interface DayMetrics {
  date: string;
  ai_score_count: number;
  korea_quote_count: number;
  notification_sent: number;
  notification_failed: number;
  health: 'green' | 'yellow' | 'red';
}

export default async function DataQualityPage() {
  const sb = await getQueryClient();
  const since = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);

  const [
    { data: aiScores },
    { data: koreaQuotes },
    { data: notifs },
    { data: errors },
  ] = await Promise.all([
    sb.from('ai_scores').select('date').gte('date', since),
    sb.from('korea_market').select('date').gte('date', since),
    sb.from('notifications').select('date, status, error, sent_at').gte('date', since).order('sent_at', { ascending: false }),
    sb.from('audit_logs').select('action, resource_type, resource_id, changes, created_at').like('action', '%error%').order('created_at', { ascending: false }).limit(20),
  ]);

  const dates = lastNDays(14);
  const aiByDate = countByDate((aiScores ?? []) as { date: string }[]);
  const krByDate = countByDate((koreaQuotes ?? []) as { date: string }[]);

  const notifByDate = ((notifs ?? []) as Array<{ date: string; status: string }>).reduce(
    (acc, n) => {
      const k = n.date;
      acc[k] = acc[k] ?? { sent: 0, failed: 0 };
      if (n.status === 'sent') acc[k].sent += 1;
      if (n.status === 'failed') acc[k].failed += 1;
      return acc;
    },
    {} as Record<string, { sent: number; failed: number }>,
  );

  const days: DayMetrics[] = dates.map((date) => {
    const ai = aiByDate[date] ?? 0;
    const kr = krByDate[date] ?? 0;
    const notifs = notifByDate[date] ?? { sent: 0, failed: 0 };
    const aiOk = ai >= 45;
    const krOk = kr >= 45;
    const notifOk = notifs.failed === 0;
    let health: 'green' | 'yellow' | 'red' = 'green';
    if (!aiOk || !krOk) health = 'yellow';
    if (!notifOk || (ai === 0 && kr === 0)) health = 'red';
    return {
      date,
      ai_score_count: ai,
      korea_quote_count: kr,
      notification_sent: notifs.sent,
      notification_failed: notifs.failed,
      health,
    };
  });

  const errorRows = (errors ?? []) as Array<{
    action: string;
    resource_type: string | null;
    resource_id: string | null;
    changes: Record<string, unknown> | null;
    created_at: string;
  }>;

  const recentNotifFailures = ((notifs ?? []) as Array<{ date: string; status: string; error: string | null; sent_at: string }>)
    .filter((n) => n.status === 'failed')
    .slice(0, 10);

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">데이터 품질</h1>
        <p className="mt-1 text-sm text-txt-secondary">
          최근 14일 일별 수집·정제·발송 지표
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-heading">14일 카드</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-7">
            {days.map((d) => (
              <DayCard key={d.date} d={d} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-heading">일별 ai_scores 추이 (50종목 기준)</CardTitle>
        </CardHeader>
        <CardContent>
          <DailyMetricsLine data={days.map((d) => ({ date: d.date, value: d.ai_score_count }))} target={50} />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">최근 알림 실패</CardTitle>
          </CardHeader>
          <CardContent>
            {recentNotifFailures.length === 0 ? (
              <p className="text-sm text-txt-primary">최근 14일 발송 실패 없음 ✓</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {recentNotifFailures.map((n, i) => (
                  <li key={i} className="rounded-md border border-border bg-bg-secondary/60 p-2">
                    <div className="flex items-baseline justify-between">
                      <span className="font-mono">{n.date}</span>
                      <span className="text-[10px] text-txt-muted">
                        {new Date(n.sent_at).toLocaleTimeString('ko-KR')}
                      </span>
                    </div>
                    <div className="mt-1 text-status-error">{n.error ?? 'unknown error'}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">audit_logs 에러</CardTitle>
          </CardHeader>
          <CardContent>
            {errorRows.length === 0 ? (
              <p className="text-sm text-txt-primary">최근 audit_logs 에러 없음 ✓</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {errorRows.map((e, i) => (
                  <li key={i} className="rounded-md border border-border bg-bg-secondary/60 p-2">
                    <div className="flex items-baseline justify-between">
                      <Badge variant="outline" className="text-status-error">{e.action}</Badge>
                      <span className="text-[10px] text-txt-muted">
                        {new Date(e.created_at).toLocaleString('ko-KR')}
                      </span>
                    </div>
                    {e.resource_id && (
                      <div className="mt-1 font-mono text-[10px] text-txt-muted">{e.resource_id}</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-txt-muted">
        지표 임계값 — ai_scores·korea_market &lt; 45 → 노란색, 알림 실패 발생 → 빨간색
      </p>
    </div>
  );
}

function DayCard({ d }: { d: DayMetrics }) {
  const tone =
    d.health === 'green' ? 'border-status-success/30 bg-status-success/5'
    : d.health === 'yellow' ? 'border-status-warning/30 bg-status-warning/5'
    : 'border-status-error/30 bg-status-error/5';
  const dot =
    d.health === 'green' ? 'bg-status-success'
    : d.health === 'yellow' ? 'bg-status-warning'
    : 'bg-status-error';
  return (
    <div className={`rounded-md border p-2.5 ${tone}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span className="font-mono text-[10px] text-txt-muted">{d.date.slice(5)}</span>
      </div>
      <div className="mt-1.5 space-y-0.5 text-[11px]">
        <div className="flex justify-between">
          <span className="text-txt-muted">AI</span>
          <span className="font-mono">{d.ai_score_count}/50</span>
        </div>
        <div className="flex justify-between">
          <span className="text-txt-muted">KR</span>
          <span className="font-mono">{d.korea_quote_count}/50</span>
        </div>
        <div className="flex justify-between">
          <span className="text-txt-muted">알림</span>
          <span className="font-mono">
            {d.notification_sent}{d.notification_failed > 0 && (
              <span className="text-status-error"> /{d.notification_failed}</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function countByDate(rows: { date: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.date] = (out[r.date] ?? 0) + 1;
  }
  return out;
}

function lastNDays(n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  }
  return out;
}
