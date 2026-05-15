import { Suspense } from 'react';

import { FullscreenChartViewer, type FsMode, type FsPeriod } from '@/components/charts/fullscreen-chart-viewer';

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
          initialPeriod={period}
          initialMode={mode}
        />
      </Suspense>
    </div>
  );
}
