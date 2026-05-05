import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { getRecentReportDates } from '@/lib/queries/reports';
import { changeColor, formatKoreanDate, formatPercent } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ReportsPage() {
  const items = await getRecentReportDates(30);

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">일일 리포트</h1>
        <p className="mt-1 text-sm text-txt-secondary">최근 30일 신호 히스토리</p>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            아직 리포트 기록이 없습니다. 일일 파이프라인이 실행되면 표시됩니다.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <Link
              key={it.date}
              href={`/reports/${it.date}`}
              className="group flex items-center gap-3 px-4 py-3 rounded-md border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 hover:border-hover-strong transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-txt-primary">{formatKoreanDate(it.date)}</div>
                <div className="mt-0.5 text-xs text-txt-muted">
                  NASDAQ <span className={changeColor(it.nasdaqChange)}>{formatPercent(it.nasdaqChange)}</span>
                  {' · '}
                  강한 관심 <span className="text-brand-purple">{it.strongCount}</span>개
                  {' · '}
                  위험 <span className="text-status-error">{it.riskCount}</span>개
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-txt-muted group-hover:text-txt-primary" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
