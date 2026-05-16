import { Suspense } from 'react';

import { FullscreenChartViewer, type FsMode, type FsPeriod } from '@/components/charts/fullscreen-chart-viewer';
import { getQueryClient } from '@/lib/supabase/query-client';

// Dedicated full-screen chart viewer page. Reuses /api/{kr,us}-chart
// data feeds the compact StockChart already uses, but renders inside
// a wider canvas with extra indicators (Bollinger, RSI), MA period
// toggles, linear/log scale, and a compare-symbol overlay.
//
// URL contract (query params, all optional):
//   ?variant=kr|us   default: kr
//   ?symbol=AAPL     US variant only — when the symbol differs from ticker
//   ?period=1d|5d|1w|1m|3m|6m|ytd|1y|5y|all   default: 3m
//   ?mode=candle|line|area   default: candle

interface Params {
  ticker: string;
}
interface Search {
  variant?: string;
  symbol?: string;
  period?: string;
  mode?: string;
}

const VALID_PERIODS: FsPeriod[] = ['1d', '5d', '1w', '1m', '3m', '6m', 'ytd', '1y', '5y', 'all'];
const VALID_MODES: FsMode[] = ['candle', 'line', 'area'];

export default async function FullscreenChartPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const { ticker } = await params;
  const search = await searchParams;

  const variant: 'kr' | 'us' = search.variant === 'us' ? 'us' : 'kr';
  const periodParam = (search.period ?? '').toLowerCase();
  const period: FsPeriod = VALID_PERIODS.includes(periodParam as FsPeriod)
    ? (periodParam as FsPeriod)
    : '3m';
  const modeParam = (search.mode ?? '').toLowerCase();
  const mode: FsMode = VALID_MODES.includes(modeParam as FsMode)
    ? (modeParam as FsMode)
    : 'candle';

  // Look up the stock's display name + sector so the header can show
  // "삼성SDI 098460" instead of the bare ticker. For KR variant we
  // query the `stocks` table (only watchlist + master rows guaranteed
  // present). US variant — pass through whatever symbol was given;
  // a future enhancement can hit the US stocks table similarly.
  let stockName: string | null = null;
  let sector: string | null = null;
  if (variant === 'kr') {
    try {
      const sb = await getQueryClient();
      const { data } = await sb
        .from('stocks')
        .select('name, sector')
        .eq('ticker', ticker)
        .maybeSingle();
      stockName = (data?.name as string | undefined) ?? null;
      sector = (data?.sector as string | undefined) ?? null;
    } catch {
      // Silently fall back to ticker-only display — page should still
      // render even when DB lookup fails.
    }
  }

  return (
    <div className="space-y-4 max-w-[1600px] mx-auto">
      <Suspense
        fallback={
          <div className="w-full h-[600px] rounded bg-bg-tertiary/40 animate-pulse" />
        }
      >
        <FullscreenChartViewer
          ticker={ticker}
          variant={variant}
          symbol={search.symbol}
          stockName={stockName}
          sector={sector}
          initialPeriod={period}
          initialMode={mode}
        />
      </Suspense>
    </div>
  );
}
