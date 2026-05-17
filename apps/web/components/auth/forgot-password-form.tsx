'use client';

/**
 * "Send me a reset link" form.
 *
 * Always shows the same success state regardless of whether the email
 * exists in our database — prevents account enumeration. Supabase
 * silently no-ops on unknown emails.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Mail } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/supabase/client';

const schema = z.object({
  email: z.string().email('올바른 이메일을 입력해주세요'),
});
type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) {
      // Don't reveal anything specific — still flip to success state.
      console.warn('[reset request] error (suppressed for UX):', error);
    }
    setSentTo(values.email);
  }

  if (sentTo) {
    return (
      <div className="rounded-md border border-status-success/30 bg-status-success/5 p-4 text-center">
        <Mail className="mx-auto h-7 w-7 text-status-success mb-2" />
        <p className="text-sm font-medium text-txt-primary">
          재설정 안내 메일을 보내드렸습니다
        </p>
        <p className="mt-1 text-xs text-txt-secondary font-mono">{sentTo}</p>
        <p className="mt-3 text-xs text-txt-muted leading-relaxed">
          해당 이메일이 등록되어 있다면 곧 메일이 도착합니다.
          <br />
          스팸함도 확인해 주세요.
        </p>
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
          autoFocus
          placeholder="you@example.com"
          {...register('email')}
        />
        {errors.email && (
          <p className="text-xs text-status-error">{errors.email.message}</p>
        )}
      </div>
      <Button
        type="submit"
        className="w-full bg-gradient-brand text-white hover:opacity-90"
        disabled={isSubmitting}
      >
        {isSubmitting ? '발송 중...' : '재설정 링크 받기'}
      </Button>
    </form>
  );
}
