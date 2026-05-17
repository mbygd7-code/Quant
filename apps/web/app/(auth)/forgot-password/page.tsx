import Link from 'next/link';

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export default function ForgotPasswordPage() {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-5">
      <div className="text-center">
        <div className="mx-auto mb-3 h-12 w-12 sidebar-symbol" />
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          비밀번호 재설정
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          가입 이메일을 입력하시면 재설정 링크를 보내드립니다.
        </p>
      </div>

      <ForgotPasswordForm />

      <p className="text-center text-xs text-txt-muted">
        <Link href="/login" className="hover:text-txt-primary">
          ← 로그인으로 돌아가기
        </Link>
      </p>
    </div>
  );
}
