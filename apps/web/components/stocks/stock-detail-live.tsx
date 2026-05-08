'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowDownRight, ArrowUpRight, Plus, Check } from 'lucide-react';
import { toast } from 'sonner';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { StockChart } from '@/components/charts/stock-chart';
import {
  adminAddOrCreateStockAction,
  adminAddToWatchlist,
} from '@/app/actions/watchlist';
import type { Role } from '@/lib/types';

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
}

export function StockDetailLive({
  ticker,
  name,
  market,
  sector,
  role,
  inWatchlist: initialInWatchlist,
  inMaster,
}: Props) {
  const router = useRouter();
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [pending, startTransition] = useTransition();
  const [inWatchlist, setInWatchlist] = useState(initialInWatchlist);

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

  const onAdd = () => {
    if (role !== 'admin') {
      toast.error('admin 권한 필요');
      return;
    }
    startTransition(async () => {
      const res = inMaster
        ? await adminAddToWatchlist(ticker)
        : await adminAddOrCreateStockAction({ ticker, name, market, sector });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`${name} 워치리스트 추가됨`);
      setInWatchlist(true);
      router.refresh();
    });
  };

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

          {role === 'admin' && (
            <Button
              type="button"
              onClick={onAdd}
              disabled={inWatchlist || pending}
              className="w-full bg-gradient-brand text-white hover:opacity-90"
            >
              {inWatchlist ? (
                <>
                  <Check className="h-4 w-4 mr-1" />워치리스트
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" />워치리스트 추가
                </>
              )}
            </Button>
          )}
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
