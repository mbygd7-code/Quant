import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { InviteForm } from '@/components/auth/invite-form';

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const supabase = await createClient();

  // Already logged in? send to dashboard
  const { data: { user } } = await supabase.auth.getUser();
  if (user) redirect('/dashboard');

  const { data: invite, error } = await supabase
    .from('invite_codes')
    .select('email, role, expires_at, used_at')
    .eq('code', token)
    .maybeSingle();

  if (error || !invite) {
    return <InviteError reason="유효하지 않은 초대 링크입니다." />;
  }
  if (invite.used_at) {
    return <InviteError reason="이미 사용된 초대 코드입니다." />;
  }
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return <InviteError reason="만료된 초대 코드입니다. 관리자에게 재발급을 요청해 주세요." />;
  }

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-5">
      <div className="text-center">
        <div className="mx-auto mb-3 h-12 w-12 sidebar-symbol" />
        <h1 className="font-heading text-2xl font-semibold">QuantSignal 가입</h1>
        <p className="mt-1 text-sm text-txt-secondary">
          {invite.email} · 권한 <span className="text-txt-primary">{invite.role}</span>
        </p>
      </div>
      <InviteForm token={token} email={invite.email} />
      <p className="text-center text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}

function InviteError({ reason }: { reason: string }) {
  return (
    <div className="rounded-xl border border-status-error/30 bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-4">
      <h1 className="font-heading text-lg font-semibold text-status-error">초대 오류</h1>
      <p className="text-sm text-txt-secondary">{reason}</p>
      <Button asChild variant="outline" className="w-full">
        <Link href="/login">로그인 페이지로</Link>
      </Button>
    </div>
  );
}
