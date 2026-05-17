'use client';

/**
 * Email + password login.
 *
 * Replaces the earlier OTP-only flow. Password is the primary path;
 * users who forget it use /forgot-password (PR-B). Magic-link/OTP can
 * be re-added later if needed — Supabase keeps both enabled by default.
 *
 * Dev quick-login (5 seed accounts) is preserved in development for
 * fast iteration. Production builds strip it.
 */
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const schema = z.object({
  email: z.string().email('올바른 이메일을 입력해주세요'),
  password: z.string().min(1, '비밀번호를 입력해주세요'),
});
type Values = z.infer<typeof schema>;

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  // Honor the ?next= hint set by middleware when an unauthenticated
  // request bounced off a protected route.
  const nextPath = search.get('next') || '/dashboard';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email: values.email,
      password: values.password,
    });
    if (error) {
      // Supabase 메시지 그대로 노출하면 enumeration 약점 — 한국어
      // 일반 문구로 변환. (특정 사례만 구분: 이메일 미확인은 별도 안내)
      const m = error.message.toLowerCase();
      if (m.includes('email not confirmed')) {
        toast.error('이메일 인증이 필요합니다. 가입 시 받은 확인 메일을 먼저 열어주세요.');
      } else {
        toast.error('이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      return;
    }
    toast.success('로그인 완료');
    router.replace(nextPath);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">이메일</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus
          {...register('email')}
        />
        {errors.email && (
          <p className="text-xs text-status-error">{errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="password">비밀번호</Label>
          <Link
            href="/forgot-password"
            className="text-[11px] text-txt-muted hover:text-txt-primary"
          >
            비밀번호를 잊으셨나요?
          </Link>
        </div>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-xs text-status-error">{errors.password.message}</p>
        )}
      </div>

      <Button
        type="submit"
        className="w-full bg-gradient-brand text-white hover:opacity-90"
        disabled={isSubmitting}
      >
        {isSubmitting ? '로그인 중...' : '로그인'}
      </Button>

      <div className="flex items-center justify-between gap-2 text-xs text-txt-muted">
        <span>
          아직 계정이 없으신가요?{' '}
          <Link href="/signup" className="text-txt-primary hover:underline">
            회원가입
          </Link>
        </span>
        <Link href="/invite" className="hover:text-txt-primary">
          초대 코드로 가입
        </Link>
      </div>

      <DevQuickLogin />
    </form>
  );
}

function DevQuickLogin() {
  const router = useRouter();
  const [busy, setBusy] = useState<number | null>(null);

  if (process.env.NODE_ENV === 'production') return null;

  async function quickLogin(idx: number) {
    setBusy(idx);
    try {
      const res = await fetch('/api/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: idx }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(`Dev #${idx} 로그인 실패: ${data?.error ?? res.statusText}`);
        return;
      }
      toast.success(`Dev #${idx} 로그인 (${data.email})`);
      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      toast.error(`Dev #${idx} 로그인 오류: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 rounded-md border border-dashed border-border bg-bg-tertiary/30 p-3">
      <div className="mb-2 text-center text-[10px] uppercase tracking-wider text-txt-muted">
        Dev Quick Login (개발 전용)
      </div>
      <div className="grid grid-cols-5 gap-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <Button
            key={n}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => quickLogin(n)}
            disabled={busy !== null}
            className="font-mono"
          >
            {busy === n ? '...' : n}
          </Button>
        ))}
      </div>
    </div>
  );
}
