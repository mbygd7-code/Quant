import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SignalBadge } from '@/components/signals/signal-badge';
import { SubscoreBar } from '@/components/charts/subscore-bar';
import { ScoreTrend } from '@/components/charts/score-trend';
import { PriceForecastChart } from '@/components/charts/price-forecast-chart';
import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH, getQueryClient } from '@/lib/supabase/query-client';
import { getStockDetail } from '@/lib/queries/reports';
import { getVoterBreakdown } from '@/lib/queries/voters';
import type { Role, Signal } from '@/lib/types';
import { StockDetailLive } from '@/components/stocks/stock-detail-live';
import { VoterBreakdownCard } from '@/components/signals/voter-breakdown';
import { KR_TICKER_RE } from '@/lib/ticker';
import { gradeToLabel, type SignalGrade } from '@/lib/signal-resolver';

export const dynamic = 'force-dynamic';

interface Props {
  params: { ticker: string };
}

const FACTOR_LABELS: Record<string, string> = {
  global_market_score: '글로벌 시장',
  sector_score: '섹터 온도',
  related_us_stock_score: '미국 관련주',
  news_sentiment_score: '뉴스 감성',
  fundamental_score: '펀더멘털',
  volume_flow_score: '수급/거래대금',
  risk_penalty: '리스크 패널티',
  kr_fear_greed_score: '한국 F&G (역방향)',
  kr_trade_score: '수출입 동향',
};

export default async function KrStockDetail({ params }: Props) {
  const ticker = params.ticker.toUpperCase();
  if (!KR_TICKER_RE.test(ticker)) notFound();

  // ── Auth + role
  let role: Role = 'admin';
  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) redirect('/login');
    const { data: profile } = await sb
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    role = ((profile?.role as Role) ?? 'user') as Role;
  }

  // ── Meta + latest scored date in parallel
  const sb = await getQueryClient();
  const [stockRes, latestScoreRes] = await Promise.all([
    sb
      .from('stocks')
      .select('ticker, name, market, sector, is_watchlist')
      .eq('ticker', ticker)
      .maybeSingle(),
    sb
      .from('ai_scores')
      .select('date')
      .eq('ticker', ticker)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const stock = stockRes.data;
  const latestDate = latestScoreRes.data?.date as string | undefined;

  // If the master has only a placeholder name (== ticker) or is missing
  // entirely, hit NAVER for a friendly Korean name + market so the page
  // header doesn't read "455850 KOSPI".
  let resolved: { name?: string; market?: string; sector?: string | null } = {};
  const masterName = (stock?.name as string | undefined)?.trim() ?? '';
  if (!stock || masterName === '' || masterName === ticker) {
    try {
      const res = await fetch(
        `https://m.stock.naver.com/api/stock/${ticker}/integration`,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            Accept: 'application/json',
          },
          cache: 'no-store',
        },
      );
      if (res.ok) {
        const j = (await res.json()) as {
          stockName?: string;
          stockExchangeType?: { code?: string; name?: string };
          industryCodeType?: { name?: string };
        };
        if (j.stockName) {
          resolved = {
            name: j.stockName,
            market:
              j.stockExchangeType?.code === 'KOSPI' ||
              j.stockExchangeType?.code === 'KOSDAQ'
                ? j.stockExchangeType.code
                : (j.stockExchangeType?.name ?? undefined),
            sector: j.industryCodeType?.name ?? null,
          };
        }
      }
    } catch {
      /* offline / NAVER hiccup — fallback to ticker */
    }
  }

  // ── Rich AI detail (only when a score exists for this ticker)
  const [detail, voterBreakdown] = await Promise.all([
    latestDate ? getStockDetail(latestDate, ticker) : Promise.resolve(null),
    getVoterBreakdown(ticker),
  ]);

  const masterNameUsable = masterName && masterName !== ticker;
  const meta = {
    ticker,
    name:
      (masterNameUsable ? masterName : undefined) ??
      resolved.name ??
      detail?.stock.name ??
      ticker,
    market:
      (stock?.market as string | undefined) ??
      resolved.market ??
      detail?.stock.market ??
      'KOSPI',
    sector:
      (stock?.sector as string | null | undefined) ??
      resolved.sector ??
      detail?.stock.sector ??
      null,
    inWatchlist: Boolean(stock?.is_watchlist),
    inMaster: stock !== null && stock !== undefined,
  };

  const subscore = detail
    ? (
        [
          'global_market_score',
          'sector_score',
          'related_us_stock_score',
          'news_sentiment_score',
          'fundamental_score',
          'volume_flow_score',
          'risk_penalty',
          'kr_fear_greed_score',
          'kr_trade_score',
        ] as const
      )
        .map((k) => ({
          factor: FACTOR_LABELS[k] ?? k,
          score: typeof detail.score[k] === 'number' ? (detail.score[k] as number) : 0,
        }))
        .filter((d) => d.score > 0 || d.factor === FACTOR_LABELS.risk_penalty)
    : [];

  const reasons = detail?.score.rationale_json?.reasons ?? [];
  const risks = detail?.score.rationale_json?.risks ?? [];
  const news = detail?.score.rationale_json?.related_news ?? [];

  return (
    <div className="space-y-5 fade-in">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="h-8 px-2 -ml-2">
          <Link href="/watchlist">
            <ArrowLeft className="h-4 w-4 mr-1" />
            주식리스트
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm" className="h-8">
          <a
            href={`https://m.stock.naver.com/domestic/stock/${ticker}/total`}
            target="_blank"
            rel="noreferrer"
          >
            NAVER 증권
            <ExternalLink className="h-3 w-3 ml-1" />
          </a>
        </Button>
      </div>

      {/* Title + signal */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{meta.name}</h1>
            <Badge variant="outline">{meta.market}</Badge>
            {meta.sector && <Badge variant="outline">{meta.sector}</Badge>}
            {/* "관심주식 등록" — semantic clash with the AI signal grade
                "관심" (BUY). Use a star icon + "★ 내 관심주식 등록" so a
                user reading "관심" + "관망" doesn't mistake one for
                the other. */}
            {meta.inWatchlist && (
              <Badge
                variant="outline"
                className="border-status-warning/40 text-status-warning gap-1"
                title="이 종목은 시스템 마스터 watchlist에 등록되어 있어 매일 자동 분석됩니다"
              >
                <span aria-hidden>★</span>
                마스터 등록
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-txt-secondary">
            <span className="font-mono">{meta.ticker}</span>
            {detail && (
              <span> · 분석 기준 <span className="font-mono">{detail.date}</span></span>
            )}
          </p>
        </div>
        {(voterBreakdown || detail) && (
          <SignalBadge
            signal={
              voterBreakdown
                ? gradeToLabel(voterBreakdown.signal_grade as SignalGrade)
                : detail!.score.signal
            }
          />
        )}
      </header>

      {/* Signal preference — final_signals (M4 character system) wins
          over the legacy ai_scores reading so the top card and the 6-voter
          card can never disagree. We use confidence directly when present
          and fall back to a -2..+2 → 0..1 mapping of weighted_score.
          When neither final_signals row exists yet, fall through to legacy. */}
      <StockDetailLive
        ticker={meta.ticker}
        name={meta.name}
        market={meta.market as 'KOSPI' | 'KOSDAQ'}
        sector={meta.sector}
        role={role}
        inWatchlist={meta.inWatchlist}
        inMaster={meta.inMaster}
        signal={
          voterBreakdown
            ? gradeToLabel(voterBreakdown.signal_grade as SignalGrade)
            : (detail?.score.signal as Signal | undefined) ?? null
        }
        finalScore={
          voterBreakdown
            ? // The headline score must be monotonic with the grade so a
              // user reading "강한 관심" never sees a 50/100 underneath
              // (that was confidence, not strength). weighted_score is
              // the value that derives the grade — normalize -2..+2 →
              // 0..100. Confidence becomes a separate signal below.
              (voterBreakdown.weighted_score != null
                ? ((voterBreakdown.weighted_score + 2) / 4)
                : voterBreakdown.confidence ?? null)
            : detail?.score.final_score ?? null
        }
        confidence={voterBreakdown?.confidence ?? null}
      />

      {/* 6-Voter breakdown — the new character-system view. Sits between
          the price/chart card and the legacy AI commentary so users see
          the canonical signal first, then the per-voter rationale. */}
      {voterBreakdown && <VoterBreakdownCard data={voterBreakdown} />}

      {/* AI commentary (legacy) */}
      {/* Legacy 'AI 퀀트 전문가 분석' card — only render when the new
          character-system breakdown is unavailable. The character system's
          Soros narrative already lives inside <VoterBreakdownCard /> above
          so showing both produces conflicting headlines (legacy may say
          '적자 전환 심화' while final_signals says '강한 관심'). */}
      {!voterBreakdown && detail?.commentary && (
        <Card className="border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 via-transparent to-transparent">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <CardTitle className="text-base font-heading flex items-center gap-2">
                <span className="inline-block h-6 w-6 rounded-full bg-gradient-brand" />
                AI 퀀트 전문가 분석
              </CardTitle>
              <span className="text-[10px] text-txt-muted font-mono">
                {detail.commentary.model}
              </span>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm font-medium text-txt-primary">{detail.commentary.headline}</p>
            <p className="text-sm leading-relaxed text-txt-primary whitespace-pre-line">
              {detail.commentary.body}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {detail.commentary.short_term && (
                <div className="rounded-md border border-border bg-bg-secondary/60 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted mb-1">
                    단기 (1주)
                  </div>
                  <p className="text-sm text-txt-primary">{detail.commentary.short_term}</p>
                </div>
              )}
              {detail.commentary.mid_term && (
                <div className="rounded-md border border-border bg-bg-secondary/60 p-3">
                  <div className="text-[11px] uppercase tracking-wider text-txt-muted mb-1">
                    중기 (1개월)
                  </div>
                  <p className="text-sm text-txt-primary">{detail.commentary.mid_term}</p>
                </div>
              )}
            </div>
            {(detail.commentary.catalysts.length > 0 || detail.commentary.risks.length > 0) && (
              <div className="grid gap-3 md:grid-cols-2">
                {detail.commentary.catalysts.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-txt-primary mb-2">
                      카탈리스트
                    </div>
                    <ul className="space-y-1.5">
                      {detail.commentary.catalysts.map((c, i) => (
                        <li key={i} className="flex gap-2 text-sm text-txt-primary">
                          <span className="text-txt-primary shrink-0">•</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {detail.commentary.risks.length > 0 && (
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-status-warning mb-2">
                      리스크
                    </div>
                    <ul className="space-y-1.5">
                      {detail.commentary.risks.map((r, i) => (
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

      {/* Reasons / risks */}
      {/* Legacy '긍정 근거 / 리스크' two-column card — also from ai_scores
          rationale_json. Hide when the character system has produced a
          signal so we don't show contradictory bullet points alongside
          the Soros narrative. */}
      {!voterBreakdown && (reasons.length > 0 || risks.length > 0) && (
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
                      <span className="text-txt-primary shrink-0">•</span>
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

      {/* Sub-score breakdown */}
      {/* Legacy '7요소 sub-score' — replaced by the per-voter bars in
          <VoterBreakdownCard /> when the character system has data.
          Still useful as a fallback view for tickers without a
          final_signals row yet. */}
      {!voterBreakdown && subscore.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">9요소 sub-score</CardTitle>
          </CardHeader>
          <CardContent>
            <SubscoreBar data={subscore} />
          </CardContent>
        </Card>
      )}

      {/* Price forecast — KRW axis, random-walk-with-drift cone. This is
          the primary, intuitive chart: actual price + 5-day forecast range. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base font-heading">주가 추이 · 예측</CardTitle>
        </CardHeader>
        <CardContent>
          <PriceForecastChart ticker={meta.ticker} />
        </CardContent>
      </Card>

      {/* Score trend — actual vs ML predicted with residual readout.
          Secondary / diagnostic: shows the AI score series and model fit. */}
      {detail && detail.scoreHistory.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">AI 점수 추이 (진단용)</CardTitle>
          </CardHeader>
          <CardContent>
            <ScoreTrend
              ticker={meta.ticker}
              data={detail.scoreHistory.map((p) => ({ date: p.date, final_score: p.final_score }))}
              mlPredictions={detail.predictions.map((p) => ({
                target_date: p.target_date,
                predicted_score: p.predicted_score,
                lower_95: p.lower_95,
                upper_95: p.upper_95,
                model_version: p.model_version,
              }))}
              mlEvaluation={detail.pastPredictions.map((p) => ({
                target_date: p.target_date,
                predicted_score: p.predicted_score,
                model_version: p.model_version,
              }))}
            />
          </CardContent>
        </Card>
      )}

      {/* RAG knowledge chunks */}
      {detail && detail.ragChunks.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">관련 RAG 청크</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {detail.ragChunks.map((c) => (
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

      {/* News */}
      {news.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-heading">관련 뉴스</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {news.slice(0, 5).map((n, i) => (
              <a
                key={i}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm text-txt-primary hover:underline"
              >
                {n.title} {n.source && <span className="text-xs text-txt-muted">· {n.source}</span>}
              </a>
            ))}
          </CardContent>
        </Card>
      )}

      {!detail && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-txt-muted">
            아직 이 종목에 대한 AI 분석 데이터가 쌓이지 않았습니다.
            <br />
            매일 07/12/16 KST 자동 분석 후 결과가 여기에 표시됩니다.
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 text-xs text-txt-muted">
          본 정보는 NAVER가 제공하는 시세 자료와 자체 AI 분석을 기반으로 하며 매매 권유가 아닙니다.
          실시간 호가·체결은 증권사 단말을 사용하세요.
        </CardContent>
      </Card>
    </div>
  );
}
