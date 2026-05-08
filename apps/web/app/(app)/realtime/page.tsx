import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH, getQueryClient } from '@/lib/supabase/query-client';
import type { Role } from '@/lib/types';
import { RealtimeMonitor, type UsCandidate } from '@/components/realtime/realtime-monitor';

export const dynamic = 'force-dynamic';

// Curated leading-indicator US tickers covering QuantSignal's 5 KR sectors.
// Used when us_kr_mapping is empty / sparse.
const FALLBACK_US: UsCandidate[] = [
  // 반도체
  { symbol: 'NVDA', name: 'NVIDIA',          sector: '반도체' },
  { symbol: 'TSM',  name: 'TSMC',            sector: '반도체' },
  { symbol: 'AMD',  name: 'AMD',             sector: '반도체' },
  { symbol: 'AVGO', name: 'Broadcom',        sector: '반도체' },
  { symbol: 'ASML', name: 'ASML',            sector: '반도체' },
  { symbol: 'MU',   name: 'Micron',          sector: '반도체' },
  { symbol: 'QCOM', name: 'Qualcomm',        sector: '반도체' },
  { symbol: 'AMAT', name: 'Applied Materials', sector: '반도체' },
  // 2차전지
  { symbol: 'TSLA', name: 'Tesla',           sector: '2차전지/자동차' },
  { symbol: 'F',    name: 'Ford',            sector: '자동차' },
  { symbol: 'GM',   name: 'General Motors',  sector: '자동차' },
  // 인터넷/AI
  { symbol: 'GOOGL', name: 'Alphabet',       sector: '인터넷/AI' },
  { symbol: 'MSFT', name: 'Microsoft',       sector: '인터넷/AI' },
  { symbol: 'META', name: 'Meta',            sector: '인터넷/AI' },
  { symbol: 'AAPL', name: 'Apple',           sector: '인터넷/AI' },
  { symbol: 'AMZN', name: 'Amazon',          sector: '인터넷/AI' },
  { symbol: 'PLTR', name: 'Palantir',        sector: '인터넷/AI' },
  // 바이오
  { symbol: 'LLY',  name: 'Eli Lilly',       sector: '바이오/헬스' },
  { symbol: 'NVO',  name: 'Novo Nordisk',    sector: '바이오/헬스' },
  // ETFs (벤치마크)
  { symbol: 'SPY',  name: 'S&P 500 ETF',     sector: 'ETF' },
  { symbol: 'QQQ',  name: 'Nasdaq 100 ETF',  sector: 'ETF' },
  { symbol: 'SOXL', name: 'Semi 3x ETF',     sector: 'ETF' },
  { symbol: 'SMH',  name: 'Semi ETF',        sector: 'ETF' },
];

export default async function RealtimePage() {
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

  // Pull mapped US symbols (distinct) so admin sees the tickers actually
  // wired into our scoring pipeline first. Fall back to curated list when
  // mappings are sparse.
  const sb = await getQueryClient();
  const { data: mappingRows } = await sb
    .from('us_kr_mapping')
    .select('us_symbol, impact_strength')
    .order('impact_strength', { ascending: false })
    .limit(60);

  // Equity-only filter — exclude FX (USDKRW), indices (^GSPC), futures, etc.
  // Finnhub WebSocket free tier streams US equities + select global names.
  const EQUITY_RE = /^[A-Z]{1,5}$/;
  const mapped: UsCandidate[] = [];
  const seen = new Set<string>();
  for (const r of mappingRows ?? []) {
    const sym = String(r.us_symbol ?? '').toUpperCase().trim();
    if (!sym || seen.has(sym)) continue;
    if (!EQUITY_RE.test(sym)) continue;
    seen.add(sym);
    mapped.push({ symbol: sym, name: sym, sector: '매핑 종목' });
  }

  const candidates = [
    ...mapped,
    ...FALLBACK_US.filter((c) => !seen.has(c.symbol)),
  ];

  return <RealtimeMonitor candidates={candidates} role={role} />;
}
