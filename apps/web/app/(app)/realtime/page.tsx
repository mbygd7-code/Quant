import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { getWatchlistForUser } from '@/lib/queries/watchlist';
import type { Role } from '@/lib/types';
import { RealtimeMonitor } from '@/components/realtime/realtime-monitor';

export const dynamic = 'force-dynamic';

export default async function RealtimePage() {
  let userId = 'dev-bypass';
  let role: Role = 'admin';

  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const {
      data: { user },
    } = await sb.auth.getUser();
    if (!user) redirect('/login');
    userId = user.id;

    const { data: profile } = await sb
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    role = ((profile?.role as Role) ?? 'user') as Role;
  }

  const rows = await getWatchlistForUser(userId, role);
  const candidates = rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    market: r.market,
    sector: r.sector,
  }));

  const hasKey = Boolean(process.env.ALPHA_VANTAGE_KEY);

  return <RealtimeMonitor candidates={candidates} hasKey={hasKey} />;
}
