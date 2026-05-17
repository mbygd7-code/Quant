import Link from 'next/link';

import { ResetPasswordForm } from '@/components/auth/reset-password-form';

/**
 * Landing page for the password-reset email link.
 *
 * The link Supabase sends has a `code` query param that we must
 * exchange for a session before the user can call updateUser. The
 * exchange happens client-side here (similar to /api/auth/callback)
 * because we also want to keep the user on this page to set the
 * password in one step.
 */
export default function ResetPasswordPage() {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-5">
      <div className="text-center">
        <div className="mx-auto mb-3 h-12 w-12 sidebar-symbol" />
        <h1 className="font-heading text-xl font-semibold tracking-tight">
          새 비밀번호 설정
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          새 비밀번호를 설정하면 자동으로 로그인됩니다.
        </p>
      </div>

      <ResetPasswordForm />

      <p className="text-center text-xs text-txt-muted">
        <Link href="/login" className="hover:text-txt-primary">
          ← 로그인으로 돌아가기
        </Link>
      </p>
    </div>
  );
}
