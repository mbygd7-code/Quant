import Link from 'next/link';
import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { SignupForm } from '@/components/auth/signup-form';

export default async function SignupPage() {
  // Already logged in? send to dashboard (middleware will redirect to
  // /pending if approval is still outstanding).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect('/dashboard');

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-5">
      <div className="text-center">
        <div className="mx-auto mb-3 h-12 w-12 sidebar-symbol" />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          QuantSignal 가입
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          가입 후 이메일 인증 + 관리자 승인까지 영업일 5일 이내 처리됩니다.
        </p>
      </div>

      <SignupForm />

      <p className="text-center text-xs text-txt-muted">
        이미 계정이 있으신가요?{' '}
        <Link href="/login" className="text-txt-primary hover:underline">
          로그인
        </Link>
      </p>

      <p className="text-center text-[10px] text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
