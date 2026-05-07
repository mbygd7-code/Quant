import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { SignalBadge } from '@/components/signals/signal-badge';
import { SubscoreBar } from '@/components/charts/subscore-bar';
import { ScoreTrend } from '@/components/charts/score-trend';
import { getStockDetail } from '@/lib/queries/reports';
import {
  changeColor,
  formatKoreanDate,
  formatPercent,
  formatPrice,
  formatScore,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

const FACTOR_LABELS: Record<string, string> = {
  global_market_score: '글로벌 시장',
  sector_score: '섹터 온도',
  related_us_stock_score: '미국 관련주',
  news_sentiment_score: '뉴스 감성',
  fundamental_score: '펀더멘털',
  volume_flow_score: '수급/거래대금',
  risk_penalty: '리스크 패널티',
};

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ date: string; ticker: string }>;
}) {
  const { date, ticker } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const data = await getStockDetail(date, ticker);
  if (!data) notFound();

  const { stock, score, quote, scoreHistory, ragChunks, commentary } = data;
  const reasons = score.rationale_json?.reasons ?? [];
  const risks = score.rationale_json?.risks ?? [];
  const news = score.rationale_json?.related_news ?? [];

  const subscore = (
    [
      'global_market_score',
      'sector_score',
      'related_us_stock_score',
      'news_sentiment_score',
      'fundamental_score',
      'volume_flow_score',
      'risk_penalty',
    ] as const
  )
    .map((k) => ({
      factor: FACTOR_LABELS[k] ?? k,
      score: typeof score[k] === 'number' ? (score[k] as number) : 0,
    }))
    .filter((d) => d.score > 0 || d.factor === FACTOR_LABELS.risk_penalty);

  return (
    <div className="space-y-6 fade-in">
      <div>
        <Link
          href={`/reports/${date}`}
          className="inline-flex items-center text-xs text-txt-muted hover:text-txt-primary"
        >
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          {formatKoreanDate(date)} 프리뷰로
        </Link>
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">{stock.name}</h1>
        <span className="font-mono text-sm text-txt-muted">{stock.ticker}</span>
        <Badge variant="outline">{stock.sector ?? '—'}</Badge>
        <span className="ml-auto"><SignalBadge signal={score.signal} /></span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-txt-muted font-medium">
              종합 점수
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-semibold bg-gradient-brand bg-clip-text text-transparent">
              {formatScore(score.final_score)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-txt-muted font-medium">
              종가
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-semibold tabular-nums">
              {formatPrice(quote?.close)}
            </div>
            <div className={`mt-1 font-mono text-sm ${changeColor(quote?.change_rate)}`}>
              {formatPercent(quote?.change_rate)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs uppercase tracking-wider text-txt-muted font-medium">
              거래량
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-3xl font-semibold tabular-nums">
              {quote?.volume != null ? Number(quote.volume).toLocaleString('ko-KR') : '—'}
            </div>
          </CardContent>
        </Card>
      </div>

      {commentary && (
        <Card className="border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 via-transparent to-transparent">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle className="text-base font-heading flex items-center gap-2">
                <span className="inline-block h-6 w-6 rounded-full bg-gradient-brand" />
                AI 퀀트 전문가 분석
              </CardTitle>
              <span className="text-[10px] text-txt-muted font-mono">
                {commentary.model}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium text-brand-purple">{commentary.headline}</p>
            <p className="text-sm leading-relaxed text-txt-primary whitespace-pre-line">
              {commentary.body}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {commentary.short_term && (
                <div className="rounded-md border border-border bg-bg-secondary/60 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted mb-1">
                    단기 (1주)
                  </div>
                  <p className="text-sm text-txt-primary">{commentary.short_term}</p>
                </div>
              )}
              {commentary.mid_term && (
                <div className="rounded-md border border-border bg-bg-secondary/60 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted mb-1">
                    중기 (1개월)
                  </div>
                  <p className="text-sm text-txt-primary">{commentary.mid_term}</p>
                </div>
              )}
            </div>
            {(commentary.catalysts.length > 0 || commentary.risks.length > 0) && (
              <div className="grid gap-3 md:grid-cols-2">
                {commentary.catalysts.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-status-success mb-2">
                      카탈리스트
                    </div>
                    <ul className="space-y-1.5">
                      {commentary.catalysts.map((c, i) => (
                        <li key={i} className="flex gap-2 text-sm text-txt-primary">
                          <span className="text-status-success shrink-0">•</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {commentary.risks.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-status-warning mb-2">
                      리스크
                    </div>
                    <ul className="space-y-1.5">
                      {commentary.risks.map((r, i) => (
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

      {(reasons.length > 0 || risks.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          {reasons.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-heading">긍정 근거</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-txt-primary">
                  {reasons.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-brand-purple shrink-0">•</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {risks.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-heading">리스크 확인</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-txt-primary">
                  {risks.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-status-warning shrink-0">⚠</span>
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-heading">7요소 sub-score</CardTitle>
        </CardHeader>
        <CardContent>
          <SubscoreBar data={subscore} />
        </CardContent>
      </Card>

      {scoreHistory.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">최근 30일 점수 추이</CardTitle>
          </CardHeader>
          <CardContent>
            <ScoreTrend data={scoreHistory.map((p) => ({ date: p.date, final_score: p.final_score }))} />
          </CardContent>
        </Card>
      )}

      {ragChunks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">관련 RAG 청크</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {ragChunks.map((c) => (
              <details key={c.id} className="rounded-md border border-border bg-bg-secondary/60 p-3">
                <summary className="cursor-pointer text-sm font-medium">{c.topic}</summary>
                <div className="mt-2 text-xs text-txt-secondary whitespace-pre-wrap">{c.body}</div>
                {c.risk_warning && (
                  <p className="mt-2 text-xs text-status-warning">⚠ {c.risk_warning}</p>
                )}
              </details>
            ))}
          </CardContent>
        </Card>
      )}

      {news.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">관련 뉴스</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {news.slice(0, 3).map((n, i) => (
              <a
                key={i}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm text-brand-purple hover:underline"
              >
                {n.title} {n.source && <span className="text-xs text-txt-muted">· {n.source}</span>}
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 text-xs text-txt-muted">
          본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
        </CardContent>
      </Card>
    </div>
  );
}
