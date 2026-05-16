/**
 * Lightweight watchlist feed for the LNB.
 *
 * Returns [{ticker, name, market, sector, signal, final_score}] for the
 * current user (or for the admin "global watchlist" when DEV_BYPASS_AUTH).
 * The Sidebar polls this on mount; it's intentionally cheaper than the
 * full /watchlist page query because we only need the rail's labels +
 * signal-colour badges.
 */
import { NextResponse } from 'next/server';

import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { getWatchlistForUser } from '@/lib/queries/watchlist';
import type { Role } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  let userId = 'dev-bypass';
  let role: Role = 'admin';

  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ items: [] }, { status: 200 });
    userId = user.id;
    const { data: profile } = await sb
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    role = ((profile?.role as Role) ?? 'user') as Role;
  }

  const rows = await getWatchlistForUser(userId, role);
  // Sort: signal severity first (strongest interest → caution), then score desc.
  const ORDER: Record<string, number> = {
    '강한 관심': 0,
    '관심': 1,
    '관망': 2,
    '주의': 3,
    '위험': 4,
  };
  const sorted = [...rows].sort((a, b) => {
    const ao = a.signal ? ORDER[a.signal] ?? 99 : 99;
    const bo = b.signal ? ORDER[b.signal] ?? 99 : 99;
    if (ao !== bo) return ao - bo;
    return (b.final_score ?? 0) - (a.final_score ?? 0);
  });

  return NextResponse.json({
    items: sorted.map((r) => ({
      ticker: r.ticker,
      name: r.name,
      market: r.market,
      sector: r.sector,
      signal: r.signal,
      final_score: r.final_score,
      change_rate: r.change_rate,
    })),
  });
}
