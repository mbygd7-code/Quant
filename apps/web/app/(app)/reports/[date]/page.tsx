import { notFound } from 'next/navigation';

import { Card, CardContent } from '@/components/ui/card';
import { MarketTempCard } from '@/components/signals/market-temp-card';
import { StockRow } from '@/components/signals/stock-row';
import { getReportByDate } from '@/lib/queries/reports';
import { formatKoreanDate } from '@/lib/format';

const GLOBAL_LABELS: Record<string, string> = {
  '^IXIC': 'NASDAQ Composite',
  '^GSPC': 'S&P 500',
  '^SOX':  'PHLX Semiconductor',
  '^VIX':  'VIX (변동성)',
};

export const dynamic = 'force-dynamic';

export default async function ReportDatePage({
  params,
}: {
  params: Promise<{ date: string }>;
}) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const data = await getReportByDate(date);
  if (!data) notFound();

  return (
    <div className="space-y-6 fade-in">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {formatKoreanDate(data.date)} 프리뷰
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          전체 {data.scores.length}개 종목 · 점수 desc 정렬
        </p>
      </div>

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wider text-txt-muted">글로벌 온도</h2>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          {(['^IXIC', '^GSPC', '^SOX', '^VIX'] as const).map((sym) => {
            const row = data.global.find((g) => g.symbol === sym);
            return (
              <MarketTempCard
                key={sym}
                symbol={sym}
                label={GLOBAL_LABELS[sym]}
                close={row?.close ?? null}
                changeRate={row?.change_rate ?? null}
              />
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wider text-txt-muted">종목 점수</h2>
        <div className="space-y-2">
          {data.scores.map((s) => (
            <StockRow
              key={s.ticker}
              date={data.date}
              ticker={s.ticker}
              name={s.stocks?.name ?? s.ticker}
              sector={s.stocks?.sector ?? null}
              signal={s.signal}
              finalScore={s.final_score}
              changeRate={null}
              close={null}
            />
          ))}
        </div>
      </section>

      <Card>
        <CardContent className="p-4 text-xs text-txt-muted">
          본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
        </CardContent>
      </Card>
    </div>
  );
}
