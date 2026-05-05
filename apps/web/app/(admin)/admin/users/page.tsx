import { Plus } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { getQueryClient } from '@/lib/supabase/query-client';
import { UsersTable } from '@/components/admin/users-table';
import { InviteUserDialog } from '@/components/admin/invite-user-dialog';

export const dynamic = 'force-dynamic';

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'admin' | 'beta' | 'user';
  telegram_chat_id: string | null;
  notification_enabled: boolean | null;
  created_at: string;
}

export default async function UsersPage() {
  const sb = await getQueryClient();
  const [{ data: profiles }, { data: invites }] = await Promise.all([
    sb.from('profiles')
      .select('id, email, display_name, role, telegram_chat_id, notification_enabled, created_at')
      .order('created_at', { ascending: false }),
    sb.from('invite_codes')
      .select('code, email, role, expires_at, used_at, created_at')
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const users = (profiles ?? []) as UserRow[];
  const invitesList = (invites ?? []) as Array<{
    code: string;
    email: string;
    role: string;
    expires_at: string;
    used_at: string | null;
    created_at: string;
  }>;

  const byRole: Record<string, number> = {};
  users.forEach((u) => {
    byRole[u.role] = (byRole[u.role] ?? 0) + 1;
  });
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const recent7d = users.filter((u) => u.created_at >= sevenDaysAgo).length;

  return (
    <div className="space-y-5 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">사용자 관리</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            총 {users.length}명 · 최근 7일 +{recent7d}명
          </p>
        </div>
        <InviteUserDialog>
          <Button className="bg-gradient-brand text-white hover:opacity-90">
            <Plus className="h-4 w-4 mr-1" />
            베타 초대
          </Button>
        </InviteUserDialog>
      </div>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        {(['admin', 'beta', 'user'] as const).map((role) => (
          <Card key={role}>
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-wider text-txt-muted">{role}</div>
              <div className="mt-2 font-heading text-2xl font-semibold tabular-nums">
                {byRole[role] ?? 0}
              </div>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="p-4">
            <div className="text-[11px] uppercase tracking-wider text-txt-muted">최근 7일</div>
            <div className="mt-2 font-heading text-2xl font-semibold tabular-nums text-brand-purple">
              +{recent7d}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-heading">사용자 목록</CardTitle>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p className="text-sm text-txt-secondary">등록된 사용자가 없습니다.</p>
          ) : (
            <UsersTable rows={users} />
          )}
        </CardContent>
      </Card>

      {invitesList.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-heading">최근 초대 (20건)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-border bg-bg-secondary/60 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="border-b border-border text-txt-muted">
                  <tr>
                    <th className="text-left p-2">이메일</th>
                    <th className="text-left p-2">권한</th>
                    <th className="text-left p-2">코드</th>
                    <th className="text-left p-2">상태</th>
                    <th className="text-left p-2">만료</th>
                  </tr>
                </thead>
                <tbody>
                  {invitesList.map((inv) => {
                    const expired = new Date(inv.expires_at) < new Date();
                    const status = inv.used_at
                      ? <Badge variant="outline" className="text-status-success">사용됨</Badge>
                      : expired
                      ? <Badge variant="outline" className="text-txt-muted">만료</Badge>
                      : <Badge variant="outline" className="text-brand-purple">대기</Badge>;
                    return (
                      <tr key={inv.code} className="border-b border-border-divider-faint">
                        <td className="p-2 font-mono">{inv.email}</td>
                        <td className="p-2"><Badge variant="outline">{inv.role}</Badge></td>
                        <td className="p-2 font-mono">{inv.code}</td>
                        <td className="p-2">{status}</td>
                        <td className="p-2 text-txt-muted">
                          {new Date(inv.expires_at).toLocaleDateString('ko-KR')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
