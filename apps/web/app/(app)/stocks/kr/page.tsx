import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH, getQueryClient } from '@/lib/supabase/query-client';
import type { Role } from '@/lib/types';
import { KrDiscovery } from '@/components/stocks/kr-discovery';

export const dynamic = 'force-dynamic';

export default async function KrStocksPage() {
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

    // Discovery only mutates the master watchlist (stocks.is_watchlist),
    // which is admin-only territory.
    if (role !== 'admin') redirect('/watchlist');
  }

  // Initial watchlist count for the header pill
  const queryClient = await getQueryClient();
  const { count } = await queryClient
    .from('stocks')
    .select('ticker', { count: 'exact', head: true })
    .eq('is_watchlist', true);

  return <KrDiscovery initialWatchlistCount={count ?? 0} />;
}
