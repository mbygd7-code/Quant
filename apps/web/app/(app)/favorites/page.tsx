import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import type { Role } from '@/lib/types';
import { FavoritesView } from '@/components/watchlist/favorites-view';

export const dynamic = 'force-dynamic';

/**
 * Personal 관심주식 page.
 *
 * Identical layout to /watchlist (주식리스트) but the row set comes from the
 * user's localStorage favorites instead of the admin master watchlist.
 * Implementation lives in `FavoritesView` (client) — the favorites store
 * is browser-side, so server-side rendering can't seed rows directly.
 */
export default async function FavoritesPage() {
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
  return <FavoritesView role={role} />;
}
