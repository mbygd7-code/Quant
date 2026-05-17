'use client';

/**
 * Set-new-password form for the reset flow.
 *
 * The user arrives via Supabase's reset email which carries a `?code=`
 * param. We exchange it for a session on mount; the user can then
 * call updateUser({ password }). On success they're logged in and
 * land on /dashboard (middleware routes to /pending if their
 * account hasn't been approved yet).
 */
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const schema = z
  .object({
    password: z
      .string()
      .min(12, '12자 이상 필요')
      .regex(/[A-Z]/, '대문자 포함 필요')
      .regex(/[a-z]/, '소문자 포함 필요')
      .regex(/[0-9]/, '숫자 포함 필요')
      .regex(/[^A-Za-z0-9]/, '특수문자 포함 필요'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: '비밀번호가 일치하지 않습니다',
    path: ['confirm'],
  });

type Values = z.infer<typeof schema>;

export function ResetPasswordForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [exchangeState, setExchangeState] = useState<
    'idle' | 'exchanging' | 'ready' | 'failed'
  >('idle');
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  // One-time token → session exchange.
  useEffect(() => {
    const code = search.get('code');
    if (!code) {
      setExchangeState('failed');
      setExchangeError('재설정 링크가 유효하지 않습니다. 다시 요청해 주세요.');
      return;
    }
    setExchangeState('exchanging');
    const supabase = createClient();
    supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
      if (error) {
        setExchangeState('failed');
        setExchangeError(
          error.message.toLowerCase().includes('expired')
            ? '링크가 만료되었습니다. 다시 요청해 주세요.'
            : '링크가 유효하지 않습니다. 다시 요청해 주세요.',
        );
      } else {
        setExchangeState('ready');
      }
    });
  }, [search]);

  async function onSubmit(values: Values) {
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password: values.password });
    if (error) {
      toast.error(`변경 실패: ${error.message}`);
      return;
    }
    toast.success('비밀번호가 변경되었습니다');
    router.replace('/dashboard');
    router.refresh();
  }

  if (exchangeState === 'idle' || exchangeState === 'exchanging') {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-txt-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        링크 확인 중...
      </div>
    );
  }
  if (exchangeState === 'failed') {
    return (
      <div className="rounded-md border border-status-error/30 bg-status-error/5 p-4 text-sm text-status-error">
        {exchangeError ?? '재설정 링크 검증에 실패했습니다.'}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="password">새 비밀번호</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
        />
        {errors.password && (
          <p className="text-xs text-status-error">{errors.password.message}</p>
        )}
        <p className="text-[11px] text-txt-muted">
          12자 이상 · 대문자 · 소문자 · 숫자 · 특수문자 모두 포함
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">새 비밀번호 확인</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          {...register('confirm')}
        />
        {errors.confirm && (
          <p className="text-xs text-status-error">{errors.confirm.message}</p>
        )}
      </div>
      <Button
        type="submit"
        className="w-full bg-gradient-brand text-white hover:opacity-90"
        disabled={isSubmitting}
      >
        {isSubmitting ? '변경 중...' : '비밀번호 변경'}
      </Button>
    </form>
  );
}
