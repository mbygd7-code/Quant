import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MarketTempCard } from '@/components/signals/market-temp-card';
import { SectorChip } from '@/components/signals/sector-chip';
import { StockRow } from '@/components/signals/stock-row';
import { getDashboardData } from '@/lib/queries/dashboard';
import { formatKoreanDate } from '@/lib/format';

const GLOBAL_LABELS: Record<string, string> = {
  '^IXIC': 'NASDAQ Composite',
  '^GSPC': 'S&P 500',
  '^SOX':  'PHLX Semiconductor',
  '^VIX':  'VIX (변동성)',
};

export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const data = await getDashboardData();

  if (!data) {
    return (
      <div className="space-y-4 fade-in">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">대시보드</h1>
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            아직 점수 데이터가 없습니다. 일일 파이프라인이 실행되면 표시됩니다.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 fade-in">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          오늘의 한국장 프리뷰
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          기준일 {formatKoreanDate(data.date)} · 데이터 출처 yfinance/Finnhub
        </p>
      </div>

      {data.brief && (
        <Card className="border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 via-transparent to-transparent">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle className="text-base font-heading flex items-center gap-2">
                <span className="inline-block h-6 w-6 rounded-full bg-gradient-brand" />
                AI 시장 전략가 브리핑
              </CardTitle>
              <span className="text-[10px] text-txt-muted font-mono">{data.brief.model}</span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium text-txt-primary">{data.brief.headline}</p>
            <p className="text-sm leading-relaxed text-txt-primary whitespace-pre-line">
              {data.brief.body}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {data.brief.sector_view && (
                <div className="rounded-md border border-border bg-bg-secondary/60 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted mb-1">섹터 흐름</div>
                  <p className="text-sm text-txt-primary">{data.brief.sector_view}</p>
                </div>
              )}
              {data.brief.macro_summary && (
                <div className="rounded-md border border-border bg-bg-secondary/60 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted mb-1">매크로</div>
                  <p className="text-sm text-txt-primary">{data.brief.macro_summary}</p>
                </div>
              )}
            </div>
            {(data.brief.top_picks.length > 0 || data.brief.risk_watch.length > 0) && (
              <div className="grid gap-3 md:grid-cols-2">
                {data.brief.top_picks.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-txt-primary mb-2">관심 신호</div>
                    <ul className="space-y-1.5">
                      {data.brief.top_picks.map((p, i) => (
                        <li key={i} className="flex gap-2 text-sm text-txt-primary">
                          <span className="text-txt-primary shrink-0">•</span>
                          <span>{p}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {data.brief.risk_watch.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-status-warning mb-2">리스크 워치</div>
                    <ul className="space-y-1.5">
                      {data.brief.risk_watch.map((r, i) => (
                        <li key={i} className="flex gap-2 text-sm text-txt-primary">
                          <span className="text-status-warning shrink-0">⚠</span>
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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
        <h2 className="mb-2 text-xs uppercase tracking-wider text-txt-muted">섹터 온도</h2>
        {data.sectorBuckets.length > 0 ? (
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-5">
            {data.sectorBuckets.map((s) => (
              <SectorChip key={s.sector} sector={s.sector} avgScore={s.avgScore} counts={s.counts} />
            ))}
          </div>
        ) : (
          <p className="text-xs text-txt-muted">섹터 데이터가 비어있습니다.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-xs uppercase tracking-wider text-txt-muted">상위 5종목</h2>
        {data.topScores.length > 0 ? (
          <div className="space-y-2">
            {data.topScores.map((s) => (
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
        ) : (
          <p className="text-xs text-txt-muted">점수 데이터가 비어있습니다.</p>
        )}
      </section>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-xs uppercase tracking-wider text-txt-muted font-medium">
            안내
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-txt-muted leading-relaxed">
          본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다. 신호는 글로벌 선행 시장과
          한국 관심 종목의 상관관계를 기반으로 산출되며, 실제 투자 결과를 보장하지 않습니다.
        </CardContent>
      </Card>
    </div>
  );
}
