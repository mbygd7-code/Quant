import { redirect } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TelegramLink } from '@/components/settings/telegram-link';
import { NotificationToggle } from '@/components/settings/notification-toggle';
import { createClient } from '@/lib/supabase/server';
import { DEV_BYPASS_AUTH } from '@/lib/supabase/query-client';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  if (DEV_BYPASS_AUTH) {
    return (
      <div className="space-y-4 fade-in max-w-2xl">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">설정</h1>
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            DEV_BYPASS_AUTH 모드에서는 사용자별 텔레그램 연동·알림 설정 페이지를 사용할 수 없습니다.
            정상 인증 후 다시 진입해 주세요.
          </CardContent>
        </Card>
      </div>
    );
  }

  const sb = await createClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await sb
    .from('profiles')
    .select('email, role, telegram_chat_id, telegram_link_code, link_code_expires_at, notification_enabled')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile) redirect('/login');

  const linkValid =
    profile.telegram_link_code &&
    profile.link_code_expires_at &&
    new Date(profile.link_code_expires_at) > new Date();

  return (
    <div className="space-y-6 fade-in max-w-2xl">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">설정</h1>
        <div className="mt-1 text-sm text-txt-secondary">
          {profile.email} · <Badge variant="outline" className="align-middle">{profile.role}</Badge>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-heading">텔레그램 연동</CardTitle>
        </CardHeader>
        <CardContent>
          <TelegramLink
            chatId={profile.telegram_chat_id}
            initialCode={linkValid ? profile.telegram_link_code : null}
            initialExpiresAt={linkValid ? profile.link_code_expires_at : null}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-heading">알림 설정</CardTitle>
        </CardHeader>
        <CardContent>
          <NotificationToggle initial={profile.notification_enabled ?? true} />
          <p className="mt-3 text-xs text-txt-muted">
            강한 관심·위험 신호별 토글은 추후 추가 예정입니다.
          </p>
        </CardContent>
      </Card>

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
