import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getQueryClient } from '@/lib/supabase/query-client';
import { SendPreviewButton } from '@/components/admin/send-preview-button';
import { NotificationsTable } from '@/components/admin/notifications-table';
import { DryRunPreview } from '@/components/admin/dry-run-preview';

export const dynamic = 'force-dynamic';

export default async function NotificationsAdminPage() {
  const sb = await getQueryClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const [{ data: history }, { data: latestPreview }, { data: top5 }] = await Promise.all([
    sb.from('notifications')
      .select('id, date, channel, recipient, status, error, sent_at')
      .gte('date', since)
      .order('sent_at', { ascending: false })
      .limit(100),
    sb.from('global_market')
      .select('symbol, change_rate, close, date')
      .in('symbol', ['^IXIC', '^GSPC', '^SOX', '^VIX'])
      .order('date', { ascending: false })
      .limit(8),
    sb.from('ai_scores')
      .select('ticker, signal, final_score, stocks(name, sector)')
      .order('date', { ascending: false })
      .order('final_score', { ascending: false })
      .limit(5),
  ]);

  const rows = (history ?? []) as Array<{
    id: number;
    date: string;
    channel: string;
    recipient: string | null;
    status: string;
    error: string | null;
    sent_at: string;
  }>;

  const previewMarket = latestPreview ?? [];

  const sent = rows.filter((r) => r.status === 'sent').length;
  const failed = rows.filter((r) => r.status === 'failed').length;

  return (
    <div className="space-y-5 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">알림 로그</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            최근 30일 발송 이력 · 성공 {sent} · 실패 {failed}
          </p>
        </div>
        <SendPreviewButton />
      </div>

      <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">발송 이력</CardTitle>
          </CardHeader>
          <CardContent>
            {rows.length === 0 ? (
              <p className="text-sm text-txt-secondary">최근 30일 발송 이력이 없습니다.</p>
            ) : (
              <NotificationsTable rows={rows} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading flex items-center gap-2">
              DRY_RUN 미리보기
              <Badge variant="outline" className="text-[10px]">오늘 발송 예정</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DryRunPreview
              market={(previewMarket as Array<{ symbol: string; change_rate: number | null; close: number | null }>).slice(0, 4)}
              top5={(top5 ?? []) as unknown as Array<{
                ticker: string;
                signal: string | null;
                final_score: number;
                stocks: { name: string | null; sector: string | null } | null;
              }>}
            />
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
