'use client';

import { useEffect, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Check, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { StockChart } from '@/components/charts/stock-chart';
import { SIGNAL_TONE } from '@/lib/format';
import { useFavorites } from '@/lib/use-favorites';
import type { Role, Signal } from '@/lib/types';

interface LiveQuote {
  price: number | null;
  change: number | null;
  changeRate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  marketStatus: string | null;
  tradedAt: string | null;
}

interface Props {
  ticker: string;
  name: string;
  market: 'KOSPI' | 'KOSDAQ';
  sector: string | null;
  role: Role;
  inWatchlist: boolean;
  inMaster: boolean;
  /** Latest AI signal — when present, displaces the watchlist CTA with a
   *  prominent signal panel (강한 관심 / 관심 / 관망 / 주의 / 위험). */
  signal?: Signal | null;
  /** Headline strength in [0, 1] — should be monotonic with the grade.
   *  Map weighted_score (-2..+2) → ((score + 2) / 4) so 강한 관심 always
   *  reads ≥75; never use raw confidence here (it can be low even for
   *  a strong directional call). */
  finalScore?: number | null;
  /** Optional voter-agreement signal in [0, 1]. Rendered as a small
   *  secondary label so users see both strength + agreement without
   *  conflating them. */
  confidence?: number | null;
}

export function StockDetailLive({
  ticker,
  name,
  market,
  sector,
  role,
  inWatchlist: initialInWatchlist,
  inMaster,
  signal,
  finalScore,
  confidence,
}: Props) {
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  // Personal favorites (LNB 관심주식) — same store as the Sidebar so the
  // ★ here and the LNB rail stay in lockstep.
  const { has: isFavorite, toggle: toggleFav } = useFavorites();
  const isFav = isFavorite(ticker);
  const onToggleFav = () => {
    const nowIn = toggleFav(ticker);
    toast.success(
      nowIn ? `${name} 관심주식 추가됨` : `${name} 관심주식에서 제거`,
    );
  };
  // These props still influence UI elsewhere (admin add-to-master flow is
  // now in the picker dialog, but the badge in the header still consumes
  // `inWatchlist`). Keep referenced to avoid lint noise.
  void initialInWatchlist;
  void inMaster;
  void role;
  void market;
  void sector;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = () =>
      fetch(`/api/kr-quotes?tickers=${ticker}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((j: { results?: Array<LiveQuote & { ok: boolean; ticker: string; prevClose?: number | null }> }) => {
          if (cancelled) return;
          const r = j.results?.[0];
          if (r?.ok) {
            setQuote({
              price: r.price ?? null,
              change: r.change ?? null,
              changeRate: r.changeRate ?? null,
              open: r.open ?? null,
              high: r.high ?? null,
              low: r.low ?? null,
              prevClose: r.prevClose ?? (r.price != null && r.change != null ? r.price - r.change : null),
              volume: r.volume ?? null,
              marketStatus: r.marketStatus ?? null,
              tradedAt: r.tradedAt ?? null,
            });
          }
        })
        .catch(() => {});

    void tick();
    timer = setInterval(tick, 7_000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [ticker]);

  const isUp = quote?.change != null ? quote.change > 0 : null;
  const colorCls =
    isUp === true ? 'text-status-danger' : isUp === false ? 'text-status-info' : 'text-txt-muted';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Price summary */}
      <Card className="lg:col-span-1">
        <CardContent className="p-5 space-y-4">
          <div>
            <div className="flex items-baseline gap-3">
              <span className="font-heading text-3xl font-semibold tabular-nums">
                {quote?.price != null ? `${quote.price.toLocaleString('ko-KR')}원` : '—'}
              </span>
              <span className={cn('flex items-center gap-1 text-sm font-medium tabular-nums', colorCls)}>
                {isUp === true ? (
                  <ArrowUpRight className="h-3.5 w-3.5" />
                ) : isUp === false ? (
                  <ArrowDownRight className="h-3.5 w-3.5" />
                ) : null}
                {quote?.change != null
                  ? `${quote.change > 0 ? '+' : ''}${quote.change.toLocaleString('ko-KR')}`
                  : ''}
                {quote?.changeRate != null
                  ? ` (${quote.changeRate > 0 ? '+' : ''}${quote.changeRate.toFixed(2)}%)`
                  : ''}
              </span>
            </div>
            <div className="mt-1 text-[11px] text-txt-muted">
              {quote?.marketStatus === 'OPEN'
                ? '정규장'
                : quote?.marketStatus === 'CLOSE'
                  ? '장 마감'
                  : quote?.marketStatus ?? '—'}
              {quote?.tradedAt && ` · ${quote.tradedAt.slice(0, 16).replace('T', ' ')}`}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Stat label="시가" value={quote?.open} />
            <Stat label="전일종가" value={quote?.prevClose} />
            <Stat label="고가" value={quote?.high} />
            <Stat label="저가" value={quote?.low} />
            <Stat
              label="거래량"
              value={quote?.volume}
              format={(v) => `${v.toLocaleString('ko-KR')}`}
            />
          </dl>

          {/* AI signal panel — the primary call-to-attention now lives here.
              Replaces the previous 워치리스트 toggle, which moved to the LNB
              (관심주식) and /watchlist page ★. */}
          {signal ? (
            <SignalPanel
              signal={signal}
              finalScore={finalScore ?? null}
              confidence={confidence ?? null}
            />
          ) : (
            <div className="rounded-md border border-dashed border-border-default px-3 py-3 text-center text-xs text-txt-muted">
              아직 AI 신호가 산출되지 않았습니다.
            </div>
          )}

          <Button
            type="button"
            variant={isFav ? 'outline' : 'default'}
            size="sm"
            onClick={onToggleFav}
            className={cn(
              'w-full',
              !isFav && 'bg-gradient-brand text-white hover:opacity-90',
            )}
          >
            {isFav ? (
              <>
                <Check className="h-3.5 w-3.5 mr-1" />관심주식
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1" />관심주식에 추가
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Chart */}
      <Card className="lg:col-span-2">
        <CardContent className="p-4">
          <StockChart ticker={ticker} variant="kr" height={320} />
        </CardContent>
      </Card>
    </div>
  );
}

function SignalPanel({
  signal,
  finalScore,
  confidence,
}: {
  signal: Signal;
  finalScore: number | null;
  confidence: number | null;
}) {
  const tone = SIGNAL_TONE[signal];
  // 0..1 strength → 0..100 for display. Monotonic with the grade —
  // 강한 관심 always reads ≥75, 위험 always reads ≤25.
  const strengthPct = finalScore != null ? Math.round(finalScore * 100) : null;
  const confPct = confidence != null ? Math.round(confidence * 100) : null;
  return (
    <div
      className={cn(
        'rounded-md px-3 py-3 flex items-center justify-between gap-3',
        tone.pillBg,
      )}
    >
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider opacity-70">
          AI 신호
        </span>
        <span className="text-base font-semibold leading-tight">
          {tone.label}
        </span>
        {/* Confidence as a small badge under the label — voter-agreement,
            distinct from the strength readout on the right. */}
        {confPct !== null && (
          <span className="text-[10px] opacity-70 mt-0.5">
            voter 합의 {confPct}%
          </span>
        )}
      </div>
      {strengthPct !== null && (
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider opacity-70">
            방향 강도
          </div>
          <div className="text-base font-semibold tabular-nums leading-tight">
            {strengthPct}
            <span className="text-[10px] opacity-70 ml-0.5">/100</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  format,
}: {
  label: string;
  value: number | null | undefined;
  format?: (v: number) => string;
}) {
  return (
    <>
      <dt className="text-txt-muted">{label}</dt>
      <dd className="text-right tabular-nums">
        {value == null
          ? '—'
          : format
            ? format(value)
            : `${value.toLocaleString('ko-KR')}원`}
      </dd>
    </>
  );
}
