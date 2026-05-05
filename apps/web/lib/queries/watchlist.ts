import { getQueryClient } from '@/lib/supabase/query-client';
import type { Role, Signal, Stock } from '@/lib/types';

export interface WatchlistRow {
  ticker: string;
  name: string;
  market: string;
  sector: string | null;
  signal: Signal | null;
  final_score: number | null;
  change_rate: number | null;
  close: number | null;
}

export async function getWatchlistForUser(
  userId: string,
  role: Role,
): Promise<WatchlistRow[]> {
  const sb = await getQueryClient();

  // 1) Determine ticker set by role
  let tickers: string[] = [];
  if (role === 'admin') {
    const { data } = await sb
      .from('stocks')
      .select('ticker')
      .eq('is_watchlist', true);
    tickers = (data ?? []).map((r) => r.ticker as string);
  } else {
    const { data } = await sb
      .from('user_watchlists')
      .select('ticker')
      .eq('user_id', userId);
    tickers = (data ?? []).map((r) => r.ticker as string);
  }
  if (tickers.length === 0) return [];

  // 2) Latest ai_scores date for these tickers
  const { data: latest } = await sb
    .from('ai_scores')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const latestDate = latest?.date as string | undefined;

  // 3) Parallel fetch — stocks meta + ai_scores + korea_market quote
  const [stocksRes, scoresRes, quotesRes] = await Promise.all([
    sb.from('stocks')
      .select('ticker, name, market, sector')
      .in('ticker', tickers),
    latestDate
      ? sb.from('ai_scores')
          .select('ticker, signal, final_score')
          .eq('date', latestDate)
          .in('ticker', tickers)
      : Promise.resolve({ data: [] }),
    latestDate
      ? sb.from('korea_market')
          .select('ticker, close, change_rate')
          .eq('date', latestDate)
          .in('ticker', tickers)
      : Promise.resolve({ data: [] }),
  ]);

  const stocksByTicker = new Map<string, Pick<Stock, 'name' | 'market' | 'sector'>>();
  for (const s of stocksRes.data ?? []) {
    stocksByTicker.set(s.ticker as string, {
      name: s.name as string,
      market: s.market as string,
      sector: s.sector as string | null,
    });
  }
  const scoreByTicker = new Map<string, { signal: Signal; final_score: number }>();
  for (const s of scoresRes.data ?? []) {
    scoreByTicker.set(s.ticker as string, {
      signal: s.signal as Signal,
      final_score: s.final_score as number,
    });
  }
  const quoteByTicker = new Map<string, { close: number | null; change_rate: number | null }>();
  for (const q of quotesRes.data ?? []) {
    quoteByTicker.set(q.ticker as string, {
      close: q.close as number | null,
      change_rate: q.change_rate as number | null,
    });
  }

  return tickers.map((ticker) => {
    const meta = stocksByTicker.get(ticker);
    const score = scoreByTicker.get(ticker);
    const quote = quoteByTicker.get(ticker);
    return {
      ticker,
      name: meta?.name ?? ticker,
      market: meta?.market ?? '',
      sector: meta?.sector ?? null,
      signal: score?.signal ?? null,
      final_score: score?.final_score ?? null,
      change_rate: quote?.change_rate ?? null,
      close: quote?.close ?? null,
    };
  });
}

export async function searchAvailableStocks(query: string): Promise<Pick<Stock, 'ticker' | 'name' | 'sector' | 'market'>[]> {
  if (query.trim().length < 1) return [];
  const sb = await getQueryClient();
  const { data } = await sb
    .from('stocks')
    .select('ticker, name, sector, market')
    .or(`ticker.ilike.%${query}%,name.ilike.%${query}%`)
    .eq('is_watchlist', true)
    .limit(15);
  return (data ?? []) as Pick<Stock, 'ticker' | 'name' | 'sector' | 'market'>[];
}
