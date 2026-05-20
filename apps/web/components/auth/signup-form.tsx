'use client';

/**
 * Simple signup: ID + 4-digit password → immediate login.
 *
 * No email confirmation, no admin approval. ID gets mapped to a synthetic
 * email `<id>@quantsignal.local` so Supabase Auth's email-based primary
 * key still works without exposing real addresses. After signUp succeeds
 * we immediately signInWithPassword and bounce to /dashboard.
 *
 * Operator prerequisites (one-time, Supabase Dashboard):
 *   Authentication → Providers → Email: "Confirm email" = OFF
 *   Authentication → Policies: Min password length = 4
 */
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const schema = z.object({
  id: z
    .string()
    .min(3, '3자 이상')
    .max(20, '20자 이하')
    .regex(/^[a-z0-9_]+$/, '영문 소문자, 숫자, _ 만 사용'),
  password: z.string().min(6, '6자 이상'),
});
type Values = z.infer<typeof schema>;

/** ID → synthetic email used internally by Supabase Auth. */
function idToEmail(id: string): string {
  return `${id.toLowerCase()}@quantsignal.local`;
}

export function SignupForm() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    const supabase = createClient();
    const email = idToEmail(values.id);

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password: values.password,
      options: { data: { display_name: values.id } },
    });
    if (signUpError) {
      const m = signUpError.message.toLowerCase();
      if (m.includes('already') || m.includes('registered')) {
        toast.error('이미 사용 중인 아이디입니다.');
      } else if (m.includes('password')) {
        toast.error('비밀번호 정책 오류 — Supabase 설정에서 최소 길이를 4로 낮춰주세요.');
      } else {
        toast.error(`가입 실패: ${signUpError.message}`);
      }
      return;
    }

    // Auto-login. With email confirmation OFF in the dashboard this works
    // immediately; if confirmation is still ON the signIn will fail and
    // the user sees the dashboard message guiding them to flip the toggle.
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: values.password,
    });
    if (signInError) {
      toast.error(
        '가입은 완료됐지만 자동 로그인 실패. Supabase Dashboard에서 "Confirm email"을 꺼주세요.',
      );
      return;
    }

    toast.success('가입 + 로그인 완료');
    router.replace('/dashboard');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="id">아이디</Label>
        <Input
          id="id"
          type="text"
          autoComplete="username"
          autoFocus
          placeholder="영문/숫자 3~20자"
          {...register('id')}
        />
        {errors.id && <p className="text-xs text-status-error">{errors.id.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">비밀번호</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder="6자리 이상"
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
        {isSubmitting ? '가입 중...' : '가입하고 시작하기'}
      </Button>
    </form>
  );
}
