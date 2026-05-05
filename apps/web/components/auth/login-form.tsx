'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const emailSchema = z.object({
  email: z.string().email('올바른 이메일을 입력해주세요'),
});
type EmailValues = z.infer<typeof emailSchema>;

const codeSchema = z.object({
  token: z
    .string()
    .min(6, '6자리 코드를 입력해주세요')
    .max(6, '6자리 코드를 입력해주세요')
    .regex(/^\d{6}$/, '숫자 6자리만 가능합니다'),
});
type CodeValues = z.infer<typeof codeSchema>;

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);

  const emailForm = useForm<EmailValues>({ resolver: zodResolver(emailSchema) });
  const codeForm = useForm<CodeValues>({ resolver: zodResolver(codeSchema) });

  async function sendCode(values: EmailValues) {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: values.email,
      options: {
        // PKCE 비활성화 — 6자리 코드 직접 입력 흐름이라 redirect/verifier 불필요
        shouldCreateUser: true,
      },
    });
    if (error) {
      toast.error(`코드 발송 실패: ${error.message}`);
      return;
    }
    setEmail(values.email);
    toast.success('이메일을 확인해 6자리 코드를 입력해 주세요');
  }

  async function verifyCode(values: CodeValues) {
    if (!email) return;
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: values.token,
      type: 'email',
    });
    if (error) {
      toast.error(`코드 확인 실패: ${error.message}`);
      return;
    }
    toast.success('로그인 완료');
    router.replace('/dashboard');
    router.refresh();
  }

  if (email) {
    return (
      <form onSubmit={codeForm.handleSubmit(verifyCode)} className="space-y-4">
        <div className="rounded-md border border-border bg-bg-tertiary/40 px-3 py-2 text-xs text-txt-secondary">
          <span className="text-txt-muted">코드 발송됨 →</span>{' '}
          <span className="font-mono">{email}</span>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="token">6자리 인증 코드</Label>
          <Input
            id="token"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            autoFocus
            maxLength={6}
            className="text-center font-mono text-xl tracking-[0.4em]"
            {...codeForm.register('token')}
          />
          {codeForm.formState.errors.token && (
            <p className="text-xs text-status-error">{codeForm.formState.errors.token.message}</p>
          )}
        </div>
        <Button
          type="submit"
          className="w-full bg-gradient-brand text-white hover:opacity-90"
          disabled={codeForm.formState.isSubmitting}
        >
          {codeForm.formState.isSubmitting ? '확인 중...' : '로그인'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={() => {
            setEmail(null);
            codeForm.reset();
          }}
        >
          다른 이메일로 다시 시도
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={emailForm.handleSubmit(sendCode)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">이메일</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          autoFocus
          {...emailForm.register('email')}
        />
        {emailForm.formState.errors.email && (
          <p className="text-xs text-status-error">{emailForm.formState.errors.email.message}</p>
        )}
      </div>
      <Button
        type="submit"
        className="w-full bg-gradient-brand text-white hover:opacity-90"
        disabled={emailForm.formState.isSubmitting}
      >
        {emailForm.formState.isSubmitting ? '발송 중...' : '인증 코드 받기'}
      </Button>
      <p className="text-center text-xs text-txt-muted">
        초대 코드를 받으셨나요?{' '}
        <Link href="/invite" className="text-brand-purple hover:underline">
          초대 가입
        </Link>
      </p>
    </form>
  );
}
