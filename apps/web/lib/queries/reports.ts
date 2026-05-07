import { getQueryClient } from '@/lib/supabase/query-client';
import type { AiScore, GlobalMarket, Stock, Signal, KoreaQuote, RagChunk } from '@/lib/types';

export interface ReportListItem {
  date: string;
  nasdaqChange: number | null;
  strongCount: number;
  riskCount: number;
}

export async function getRecentReportDates(days = 30): Promise<ReportListItem[]> {
  const sb = await getQueryClient();
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString().slice(0, 10);

  const { data } = await sb
    .from('ai_scores')
    .select('date, signal')
    .gte('date', sinceIso)
    .order('date', { ascending: false });

  const buckets = new Map<string, { strong: number; risk: number }>();
  for (const r of data ?? []) {
    const date = r.date as string;
    const b = buckets.get(date) ?? { strong: 0, risk: 0 };
    if (r.signal === '강한 관심') b.strong += 1;
    if (r.signal === '위험') b.risk += 1;
    buckets.set(date, b);
  }

  if (buckets.size === 0) return [];

  const dates = Array.from(buckets.keys()).sort().reverse();
  const { data: ixicRows } = await sb
    .from('global_market')
    .select('date, change_rate')
    .eq('symbol', '^IXIC')
    .in('date', dates);
  const ixicByDate = new Map<string, number | null>();
  for (const r of ixicRows ?? []) {
    ixicByDate.set(r.date as string, r.change_rate as number | null);
  }

  return dates.map((date) => {
    const b = buckets.get(date)!;
    return {
      date,
      nasdaqChange: ixicByDate.get(date) ?? null,
      strongCount: b.strong,
      riskCount: b.risk,
    };
  });
}

export interface ReportByDateData {
  date: string;
  global: GlobalMarket[];
  scores: (AiScore & { stocks: Pick<Stock, 'name' | 'sector'> | null })[];
}

export async function getReportByDate(date: string): Promise<ReportByDateData | null> {
  const sb = await getQueryClient();
  // Indices may have a different latest date than KR ai_scores (US holiday,
  // time-zone offset). Fetch a 10-day window per symbol up to `date` and
  // pick the most recent at-or-before per symbol.
  const sinceIso = new Date(new Date(date).getTime() - 10 * 86400_000)
    .toISOString().slice(0, 10);
  const [globalWindowRes, scoresRes] = await Promise.all([
    sb.from('global_market')
      .select('*')
      .gte('date', sinceIso)
      .lte('date', date)
      .order('date', { ascending: false }),
    sb.from('ai_scores')
      .select('*, stocks(name, sector)')
      .eq('date', date)
      .order('final_score', { ascending: false }),
  ]);
  if (!scoresRes.data || scoresRes.data.length === 0) return null;

  const latestPerSymbol = new Map<string, GlobalMarket>();
  for (const r of (globalWindowRes.data ?? []) as GlobalMarket[]) {
    if (!latestPerSymbol.has(r.symbol)) latestPerSymbol.set(r.symbol, r);
  }
  return {
    date,
    global: Array.from(latestPerSymbol.values()),
    scores: scoresRes.data as ReportByDateData['scores'],
  };
}

export interface StockDetailData {
  date: string;
  ticker: string;
  stock: Stock;
  score: AiScore;
  quote: KoreaQuote | null;
  scoreHistory: { date: string; final_score: number; signal: Signal }[];
  ragChunks: RagChunk[];
}

export async function getStockDetail(date: string, ticker: string): Promise<StockDetailData | null> {
  const sb = await getQueryClient();
  const [stockRes, scoreRes, quoteRes, historyRes] = await Promise.all([
    sb.from('stocks').select('*').eq('ticker', ticker).maybeSingle(),
    sb.from('ai_scores').select('*').eq('date', date).eq('ticker', ticker).maybeSingle(),
    sb.from('korea_market').select('*').eq('date', date).eq('ticker', ticker).maybeSingle(),
    sb.from('ai_scores')
      .select('date, final_score, signal')
      .eq('ticker', ticker)
      .order('date', { ascending: false })
      .limit(30),
  ]);

  if (!stockRes.data || !scoreRes.data) return null;

  const sector = stockRes.data.sector as string | null;
  const { data: chunks } = sector
    ? await sb
        .from('rag_chunks')
        .select('id, topic, positive_signal, risk_warning, body, related_tickers, sectors')
        .or(`related_tickers.cs.{${ticker}},sectors.cs.{${sector}}`)
        .limit(3)
    : { data: [] };

  return {
    date,
    ticker,
    stock: stockRes.data as Stock,
    score: scoreRes.data as AiScore,
    quote: (quoteRes.data ?? null) as KoreaQuote | null,
    scoreHistory: (historyRes.data ?? []).reverse() as StockDetailData['scoreHistory'],
    ragChunks: (chunks ?? []) as RagChunk[],
  };
}
