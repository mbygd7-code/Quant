import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { createClient } from '@/lib/supabase/server';
import { getQueryClient, DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';
import { getWatchlistForUser } from '@/lib/queries/watchlist';
import { ROLE_WATCHLIST_LIMIT, SIGNAL_ORDER, type Role, type Signal } from '@/lib/types';
import { WatchlistTable } from '@/components/watchlist/watchlist-table';
import { AddStockDialog } from '@/components/watchlist/add-stock-dialog';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage() {
  let userId = 'dev-bypass';
  let role: Role = 'admin';

  if (!DEV_BYPASS_AUTH) {
    const sb = await createClient();
    const { data: { user } } = await sb.auth.getUser();
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
  const limit = ROLE_WATCHLIST_LIMIT[role];
  const sorted = [...rows].sort((a, b) => {
    const aOrd = a.signal ? SIGNAL_ORDER[a.signal as Signal] : 99;
    const bOrd = b.signal ? SIGNAL_ORDER[b.signal as Signal] : 99;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return (b.final_score ?? 0) - (a.final_score ?? 0);
  });

  const queryClient = await getQueryClient();
  const latestDateRow = await queryClient
    .from('ai_scores')
    .select('date')
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const linkDate = (latestDateRow.data?.date as string | null) ?? '';

  return (
    <div className="space-y-5 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">관심 종목</h1>
          <div className="mt-1 text-sm text-txt-secondary">
            {sorted.length} / {limit === 9999 ? '∞' : limit} 종목 ·{' '}
            <Badge variant="outline" className="ml-1 align-middle">{role}</Badge>
          </div>
        </div>
        {role !== 'admin' && (
          <AddStockDialog currentCount={sorted.length} limit={limit}>
            <Button className="bg-gradient-brand text-white hover:opacity-90">
              <Plus className="h-4 w-4 mr-1" />
              종목 추가
            </Button>
          </AddStockDialog>
        )}
      </div>

      {sorted.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            {role === 'admin'
              ? '관심 종목이 비어 있습니다. seed 데이터를 적용해 주세요.'
              : '아직 추가된 종목이 없습니다. 우상단 [종목 추가]로 시작하세요.'}
          </CardContent>
        </Card>
      ) : (
        <WatchlistTable rows={sorted} date={linkDate} />
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
