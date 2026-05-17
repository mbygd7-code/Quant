'use client';

/**
 * Self-signup form.
 *
 * Flow:
 *   1. User fills email + password (12+ chars, 4-char-class) + agrees to terms
 *   2. supabase.auth.signUp() — Supabase sends a confirmation email
 *   3. profiles row created with approval_status='pending' (trigger from
 *      migration 26)
 *   4. UI flips to a "check your inbox" panel; once confirmed the user
 *      can log in and they land on /pending until admin approves
 *
 * Terms / privacy text are placeholders for now (per spec) — link points
 * to /terms and /privacy stub pages.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const schema = z
  .object({
    email: z.string().email('올바른 이메일을 입력해주세요'),
    password: z
      .string()
      .min(12, '12자 이상 필요')
      .regex(/[A-Z]/, '대문자 포함 필요')
      .regex(/[a-z]/, '소문자 포함 필요')
      .regex(/[0-9]/, '숫자 포함 필요')
      .regex(/[^A-Za-z0-9]/, '특수문자 포함 필요'),
    confirm: z.string(),
    agreedTerms: z.boolean().refine((v) => v === true, {
      message: '이용약관에 동의해주세요',
    }),
    agreedPrivacy: z.boolean().refine((v) => v === true, {
      message: '개인정보처리방침에 동의해주세요',
    }),
  })
  .refine((v) => v.password === v.confirm, {
    message: '비밀번호가 일치하지 않습니다',
    path: ['confirm'],
  });

type Values = z.infer<typeof schema>;

export function SignupForm() {
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { agreedTerms: false, agreedPrivacy: false } as Partial<Values>,
  });

  const passwordValue = watch('password') ?? '';
  const strength = scorePassword(passwordValue);

  async function onSubmit(values: Values) {
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback?next=/pending`,
      },
    });
    if (error) {
      // Don't leak which emails are registered — generic message.
      // (Supabase already returns the same shape regardless, but the
      // error.message text differs; we normalize.)
      const m = error.message.toLowerCase();
      if (m.includes('already') || m.includes('registered')) {
        toast.error('이미 가입된 이메일입니다. 로그인하거나 비밀번호 찾기를 이용해주세요.');
      } else {
        toast.error(`가입 실패: ${error.message}`);
      }
      return;
    }
    setSubmittedEmail(values.email);
  }

  // Post-submit success panel.
  if (submittedEmail) {
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-status-success/30 bg-status-success/5 p-4 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-status-success mb-2" />
          <p className="text-sm font-medium text-txt-primary">확인 메일을 발송했습니다</p>
          <p className="mt-1 text-xs text-txt-secondary font-mono">{submittedEmail}</p>
          <p className="mt-3 text-xs text-txt-muted leading-relaxed">
            메일함에서 확인 링크를 클릭한 뒤 로그인해 주세요.
            <br />
            메일이 안 보이면 스팸함도 확인해주세요.
          </p>
        </div>
        <Button asChild variant="outline" className="w-full">
          <Link href="/login">로그인 페이지로</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">이메일</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          {...register('email')}
        />
        {errors.email && (
          <p className="text-xs text-status-error">{errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">비밀번호</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
        />
        {/* Strength meter — three blocks, fills as rules pass. */}
        <div className="flex items-center gap-2 text-[10px]">
          <div className="flex-1 grid grid-cols-3 gap-1">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className={
                  'h-1 rounded-full ' +
                  (i < strength
                    ? strength <= 1
                      ? 'bg-status-error'
                      : strength === 2
                        ? 'bg-status-warning'
                        : 'bg-status-success'
                    : 'bg-border-subtle')
                }
              />
            ))}
          </div>
          <span className="text-txt-muted w-12 text-right">
            {strength === 0 ? '—' : strength <= 1 ? '약함' : strength === 2 ? '보통' : '강함'}
          </span>
        </div>
        <p className="text-[11px] text-txt-muted leading-relaxed">
          12자 이상 · 대문자 · 소문자 · 숫자 · 특수문자 모두 포함
        </p>
        {errors.password && (
          <p className="text-xs text-status-error">{errors.password.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm">비밀번호 확인</Label>
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

      <div className="space-y-2 rounded-md border border-border bg-bg-tertiary/30 p-3">
        <label className="flex items-start gap-2 text-xs text-txt-secondary cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 rounded border-border-default accent-brand-purple"
            {...register('agreedTerms')}
          />
          <span>
            <Link href="/terms" target="_blank" className="text-txt-primary hover:underline">
              이용약관
            </Link>
            에 동의합니다 <span className="text-status-error">*</span>
          </span>
        </label>
        {errors.agreedTerms && (
          <p className="text-xs text-status-error ml-5">{errors.agreedTerms.message}</p>
        )}
        <label className="flex items-start gap-2 text-xs text-txt-secondary cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5 h-3.5 w-3.5 rounded border-border-default accent-brand-purple"
            {...register('agreedPrivacy')}
          />
          <span>
            <Link href="/privacy" target="_blank" className="text-txt-primary hover:underline">
              개인정보처리방침
            </Link>
            에 동의합니다 <span className="text-status-error">*</span>
          </span>
        </label>
        {errors.agreedPrivacy && (
          <p className="text-xs text-status-error ml-5">{errors.agreedPrivacy.message}</p>
        )}
      </div>

      <Button
        type="submit"
        className="w-full bg-gradient-brand text-white hover:opacity-90"
        disabled={isSubmitting}
      >
        {isSubmitting ? '가입 중...' : '가입하기'}
      </Button>
    </form>
  );
}

/** 0-3 score based on password content; mirrors zod rules so the meter
 *  matches the validator. */
function scorePassword(pw: string): number {
  if (!pw) return 0;
  let s = 0;
  if (pw.length >= 12) s += 1;
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (classes >= 3) s += 1;
  if (classes === 4 && pw.length >= 14) s += 1;
  return s;
}
