'use client';

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
  password: z.string().min(8, '8자 이상 입력해주세요'),
  confirm: z.string(),
}).refine((v) => v.password === v.confirm, {
  message: '비밀번호가 일치하지 않습니다',
  path: ['confirm'],
});

type FormValues = z.infer<typeof schema>;

export function InviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormValues) {
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password: values.password,
      options: {
        emailRedirectTo: `${window.location.origin}/api/auth/callback`,
        data: { invite_token: token },
      },
    });
    if (error) {
      toast.error(`가입 실패: ${error.message}`);
      return;
    }
    if (!data.user) {
      toast.success('확인 메일을 발송했습니다. 메일함을 확인해 주세요.');
      return;
    }
    // invite_codes.used_at marking + role promotion handled server-side by
    // handle_new_user trigger (migration 10) — no client-side update needed.
    toast.success('가입 완료 — 잠시 후 대시보드로 이동합니다');
    router.push('/dashboard');
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="password">비밀번호</Label>
        <Input id="password" type="password" autoComplete="new-password" {...register('password')} />
        {errors.password && <p className="text-xs text-status-error">{errors.password.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">비밀번호 확인</Label>
        <Input id="confirm" type="password" autoComplete="new-password" {...register('confirm')} />
        {errors.confirm && <p className="text-xs text-status-error">{errors.confirm.message}</p>}
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
