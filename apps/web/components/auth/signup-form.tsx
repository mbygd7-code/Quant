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
import { createUserAction } from '@/app/actions/auth';

const schema = z.object({
  id: z
    .string()
    .min(3, '3자 이상')
    .max(20, '20자 이하')
    .regex(/^[a-z0-9_]+$/, '영문 소문자, 숫자, _ 만 사용'),
  password: z.string().min(6, '6자 이상'),
});
type Values = z.infer<typeof schema>;

export function SignupForm() {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    // Create the user via the admin API (server action) — bypasses the
    // dashboard's "Enable Email signups" toggle and auto-confirms the
    // email so no mail is sent.
    const result = await createUserAction(values.id, values.password);
    if (!result.ok || !result.email) {
      toast.error(result.error ?? '가입 실패');
      return;
    }

    // Set browser session by signing in client-side with the same creds.
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: result.email,
      password: values.password,
    });
    if (signInError) {
      toast.error(`가입은 완료됐지만 자동 로그인 실패: ${signInError.message}`);
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
