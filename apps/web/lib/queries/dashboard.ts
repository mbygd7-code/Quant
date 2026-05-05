import { getQueryClient } from '@/lib/supabase/query-client';
import type { AiScore, GlobalMarket, Stock } from '@/lib/types';

const GLOBAL_SYMBOLS = ['^IXIC', '^GSPC', '^SOX', '^VIX'] as const;

export interface DashboardData {
  date: string;
  global: GlobalMarket[];
  topScores: (AiScore & { stocks: Pick<Stock, 'name' | 'sector'> | null })[];
  sectorBuckets: Array<{ sector: string; counts: Record<string, number>; avgScore: number }>;
}

async function getLatestAiScoreDate(): Promise<string | null> {
  const sb = await getQueryClient();
  const { data } = await sb
    .from('ai_scores')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.date ?? null;
}

export async function getDashboardData(): Promise<DashboardData | null> {
  const date = await getLatestAiScoreDate();
  if (!date) return null;

  const sb = await getQueryClient();
  const [globalRes, topRes, sectorRes] = await Promise.all([
    sb.from('global_market')
      .select('*')
      .eq('date', date)
      .in('symbol', GLOBAL_SYMBOLS as unknown as string[]),
    sb.from('ai_scores')
      .select('*, stocks(name, sector)')
      .eq('date', date)
      .order('final_score', { ascending: false })
      .limit(5),
    sb.from('ai_scores')
      .select('signal, final_score, stocks!inner(sector, is_watchlist)')
      .eq('date', date)
      .eq('stocks.is_watchlist', true),
  ]);

  const sectorBuckets = aggregateSectors(
    (sectorRes.data ?? []) as unknown as SectorJoinRow[],
  );

  return {
    date,
    global: (globalRes.data ?? []) as GlobalMarket[],
    topScores: (topRes.data ?? []) as DashboardData['topScores'],
    sectorBuckets,
  };
}

interface SectorJoinRow {
  signal: string;
  final_score: number | null;
  stocks: { sector: string | null; is_watchlist: boolean } | null;
}

function aggregateSectors(rows: SectorJoinRow[]) {
  const map = new Map<string, { counts: Record<string, number>; sum: number; n: number }>();
  for (const r of rows) {
    const sector = r.stocks?.sector;
    if (!sector) continue;
    const bucket = map.get(sector) ?? { counts: {}, sum: 0, n: 0 };
    bucket.counts[r.signal] = (bucket.counts[r.signal] ?? 0) + 1;
    if (typeof r.final_score === 'number') {
      bucket.sum += r.final_score;
      bucket.n += 1;
    }
    map.set(sector, bucket);
  }
  return Array.from(map.entries())
    .map(([sector, b]) => ({
      sector,
      counts: b.counts,
      avgScore: b.n > 0 ? b.sum / b.n : 0,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);
}
