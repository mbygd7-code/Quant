import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Clock, AlertTriangle, Ban } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { ReapplyButton } from '@/components/auth/reapply-button';
import { SignOutButton } from '@/components/auth/sign-out-button';

const APPROVAL_SLA_BUSINESS_DAYS = 5;

/**
 * Status landing page for accounts not yet usable.
 *
 * Three branches based on profiles.approval_status:
 *   pending  — wait, show D-N countdown
 *   expired  — auto-expired after 5 business days, offer reapply
 *   rejected — admin denied, offer reapply
 *
 * Approved users hitting this page get bounced to /dashboard.
 */
export default async function PendingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from('profiles')
    .select(
      'approval_status, approval_note, created_at, reapplied_at, reapply_count',
    )
    .eq('id', user.id)
    .maybeSingle();

  if (!profile) {
    // Shouldn't normally happen — handle_new_user trigger always
    // inserts. Bounce to login defensively.
    redirect('/login');
  }
  if (profile.approval_status === 'approved') {
    redirect('/dashboard');
  }

  const status = profile.approval_status as 'pending' | 'expired' | 'rejected';

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-5">
      {status === 'pending' && <PendingBlock profile={profile} email={user.email ?? ''} />}
      {status === 'expired' && <ExpiredBlock email={user.email ?? ''} />}
      {status === 'rejected' && (
        <RejectedBlock email={user.email ?? ''} note={profile.approval_note} />
      )}

      <div className="border-t border-border-subtle pt-4 text-center">
        <SignOutButton />
      </div>
      <p className="text-center text-[10px] text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}

function PendingBlock({
  profile,
  email,
}: {
  profile: { created_at: string | null; reapplied_at: string | null };
  email: string;
}) {
  const startedAt = profile.reapplied_at ?? profile.created_at;
  const remaining = startedAt
    ? remainingBusinessDays(new Date(startedAt), APPROVAL_SLA_BUSINESS_DAYS)
    : null;

  return (
    <div className="space-y-4 text-center">
      <Clock className="mx-auto h-10 w-10 text-brand-purple" />
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          관리자 승인 대기 중
        </h1>
        <p className="mt-1 text-xs text-txt-secondary font-mono">{email}</p>
      </div>
      <p className="text-sm text-txt-secondary leading-relaxed">
        가입해 주셔서 감사합니다. 관리자가 영업일 {APPROVAL_SLA_BUSINESS_DAYS}일 이내에
        승인합니다. 승인이 완료되면 다시 이메일로 안내드립니다.
      </p>
      {remaining !== null && (
        <div className="inline-flex items-center gap-2 rounded-full bg-bg-tertiary/60 px-3 py-1 text-xs font-mono">
          <span className="text-txt-muted">남은 영업일</span>
          <span
            className={
              remaining <= 1
                ? 'text-status-warning font-bold'
                : 'text-txt-primary font-bold'
            }
          >
            D-{remaining}
          </span>
        </div>
      )}
      <p className="text-[11px] text-txt-muted">
        영업일 {APPROVAL_SLA_BUSINESS_DAYS}일이 지나면 자동으로 신청이 만료되며, 다시 신청하실 수 있습니다.
      </p>
    </div>
  );
}

function ExpiredBlock({ email }: { email: string }) {
  return (
    <div className="space-y-4 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-status-warning" />
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          가입 신청이 만료되었습니다
        </h1>
        <p className="mt-1 text-xs text-txt-secondary font-mono">{email}</p>
      </div>
      <p className="text-sm text-txt-secondary leading-relaxed">
        영업일 {APPROVAL_SLA_BUSINESS_DAYS}일 이내에 관리자 검토가 이루어지지 않았습니다.
        아래 버튼으로 다시 신청해 주세요.
      </p>
      <ReapplyButton />
    </div>
  );
}

function RejectedBlock({ email, note }: { email: string; note: string | null }) {
  return (
    <div className="space-y-4 text-center">
      <Ban className="mx-auto h-10 w-10 text-status-error" />
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          가입이 거절되었습니다
        </h1>
        <p className="mt-1 text-xs text-txt-secondary font-mono">{email}</p>
      </div>
      {note && (
        <div className="rounded-md border border-border bg-bg-tertiary/30 p-3 text-left">
          <div className="text-[10px] uppercase tracking-wider text-txt-muted mb-1">
            사유
          </div>
          <p className="text-sm text-txt-primary whitespace-pre-line">{note}</p>
        </div>
      )}
      <p className="text-sm text-txt-secondary">
        문의 사항이 있으면 관리자에게 연락 주세요.
      </p>
      <div className="flex flex-col gap-2">
        <ReapplyButton label="다시 신청" />
        <Button asChild variant="outline" size="sm">
          <Link href="mailto:admin@quantsignal.local">관리자 문의</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * Calculate how many business days are left in an `SLA_DAYS` window
 * starting at `start`, relative to today. Skips Sat/Sun. Returns 0
 * when expired (caller is expected to check status separately —
 * D-0 means "expires today").
 */
function remainingBusinessDays(start: Date, slaDays: number): number {
  const now = new Date();
  // Count business days elapsed between start (exclusive) and now (inclusive).
  let elapsed = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  while (cursor < today) {
    cursor.setDate(cursor.getDate() + 1);
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) elapsed += 1;
  }
  const remaining = slaDays - elapsed;
  return Math.max(0, remaining);
}
