'use client';

/**
 * Simple ID + password login.
 *
 * ID is mapped to a synthetic `<id>@quantsignal.local` email under the
 * hood — same convention as signup-form.tsx. No magic link, no OTP,
 * no email confirmation.
 */
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
  id: z.string().min(1, '아이디를 입력해주세요'),
  password: z.string().min(1, '비밀번호를 입력해주세요'),
});
type Values = z.infer<typeof schema>;

function idToEmail(id: string): string {
  return `${id.toLowerCase()}@quantsignal.local`;
}

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const nextPath = search.get('next') || '/dashboard';

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    const supabase = createClient();
    // Accept either raw ID or full email (for legacy admin accounts that
    // signed up with a real address before the simplification).
    const email = values.id.includes('@') ? values.id : idToEmail(values.id);
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password: values.password,
    });
    if (error) {
      toast.error('아이디 또는 비밀번호가 올바르지 않습니다.');
      return;
    }
    toast.success('로그인 완료');
    router.replace(nextPath);
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
          {...register('id')}
        />
        {errors.id && <p className="text-xs text-status-error">{errors.id.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">비밀번호</Label>
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

      <p className="text-center text-xs text-txt-muted">
        아직 계정이 없으신가요?{' '}
        <Link href="/signup" className="text-txt-primary hover:underline">
          회원가입
        </Link>
      </p>
    </form>
  );
}
