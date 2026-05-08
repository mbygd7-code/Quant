import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH, getQueryClient } from '@/lib/supabase/query-client';
import type { Role } from '@/lib/types';
import { StockDetailLive } from '@/components/stocks/stock-detail-live';

export const dynamic = 'force-dynamic';

interface Props {
  params: { ticker: string };
}

export default async function KrStockDetail({ params }: Props) {
  const ticker = params.ticker;
  if (!/^\d{6}$/.test(ticker)) notFound();

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

  const sb = await getQueryClient();
  const { data: stock } = await sb
    .from('stocks')
    .select('ticker, name, market, sector, is_watchlist')
    .eq('ticker', ticker)
    .maybeSingle();

  // Stock might not be in master yet (came in from a search-only result).
  // Render with placeholder metadata in that case.
  const meta = {
    ticker,
    name: (stock?.name as string | undefined) ?? ticker,
    market: (stock?.market as string | undefined) ?? 'KOSPI',
    sector: (stock?.sector as string | null | undefined) ?? null,
    inWatchlist: Boolean(stock?.is_watchlist),
    inMaster: stock !== null && stock !== undefined,
  };

  return (
    <div className="space-y-5 fade-in">
      <div className="flex items-center justify-between gap-3">
        <Button asChild variant="ghost" size="sm" className="h-8 px-2 -ml-2">
          <Link href="/stocks/kr">
            <ArrowLeft className="h-4 w-4 mr-1" />
            국내주식
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

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{meta.name}</h1>
            <Badge variant="outline">{meta.market}</Badge>
            {meta.inWatchlist && (
              <Badge variant="outline" className="border-status-success/40 text-status-success">
                워치리스트
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-txt-secondary">
            <span className="font-mono">{meta.ticker}</span>
            {meta.sector && <span> · {meta.sector}</span>}
          </p>
        </div>
      </header>

      <StockDetailLive
        ticker={meta.ticker}
        name={meta.name}
        market={meta.market as 'KOSPI' | 'KOSDAQ'}
        sector={meta.sector}
        role={role}
        inWatchlist={meta.inWatchlist}
        inMaster={meta.inMaster}
      />

      <Card>
        <CardContent className="p-4 text-xs text-txt-muted">
          본 정보는 NAVER가 제공하는 시세 자료를 기반으로 하며 매매 권유가 아닙니다. 실시간 호가·체결은
          증권사 단말을 사용하세요.
        </CardContent>
      </Card>
    </div>
  );
}
