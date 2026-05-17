'use client';

/**
 * Account-management card for /settings.
 *
 * Three collapsible sub-sections:
 *   1. 비밀번호 변경 — current + new + confirm, 12-char/4-class rule
 *   2. 이메일 변경    — new email, sends confirmation link
 *   3. 계정 삭제      — password + "계정 삭제" typed confirm, redirects to /login
 *
 * Sensitive operations show a confirm-input pattern (GitHub-style)
 * to make accidental deletion unlikely.
 */
import { useState, useTransition } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { ChevronDown, KeyRound, Mail, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  updatePasswordAction,
  updateEmailAction,
  deleteAccountAction,
} from '@/app/actions/account';

export function AccountSection({ currentEmail }: { currentEmail: string }) {
  const [openPanel, setOpenPanel] = useState<'password' | 'email' | 'delete' | null>(null);

  function toggle(name: 'password' | 'email' | 'delete') {
    setOpenPanel((cur) => (cur === name ? null : name));
  }

  return (
    <div className="space-y-2">
      <SubPanel
        label="비밀번호 변경"
        icon={KeyRound}
        open={openPanel === 'password'}
        onToggle={() => toggle('password')}
      >
        <PasswordPanel />
      </SubPanel>

      <SubPanel
        label="이메일 변경"
        icon={Mail}
        open={openPanel === 'email'}
        onToggle={() => toggle('email')}
        hint={currentEmail}
      >
        <EmailPanel currentEmail={currentEmail} />
      </SubPanel>

      <SubPanel
        label="계정 삭제"
        icon={Trash2}
        open={openPanel === 'delete'}
        onToggle={() => toggle('delete')}
        tone="danger"
      >
        <DeletePanel />
      </SubPanel>
    </div>
  );
}

// ── Generic collapsible row ─────────────────────────────────────

function SubPanel({
  label,
  icon: Icon,
  open,
  onToggle,
  hint,
  tone = 'default',
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  open: boolean;
  onToggle: () => void;
  hint?: string;
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        'rounded-md border ' +
        (tone === 'danger'
          ? 'border-status-error/30 bg-status-error/5'
          : 'border-border bg-bg-secondary/40')
      }
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
      >
        <Icon
          className={
            'h-4 w-4 ' + (tone === 'danger' ? 'text-status-error' : 'text-txt-secondary')
          }
        />
        <span
          className={
            'text-sm font-medium flex-1 ' +
            (tone === 'danger' ? 'text-status-error' : 'text-txt-primary')
          }
        >
          {label}
        </span>
        {hint && <span className="text-xs text-txt-muted truncate max-w-[180px]">{hint}</span>}
        <ChevronDown
          className={
            'h-4 w-4 text-txt-muted transition-transform ' + (open ? 'rotate-180' : '')
          }
        />
      </button>
      {open && <div className="border-t border-border-subtle/50 px-3 py-3">{children}</div>}
    </div>
  );
}

// ── Password change ─────────────────────────────────────────────

const pwSchema = z
  .object({
    currentPassword: z.string().min(1, '현재 비밀번호 입력'),
    newPassword: z
      .string()
      .min(12, '12자 이상')
      .regex(/[A-Z]/, '대문자 포함')
      .regex(/[a-z]/, '소문자 포함')
      .regex(/[0-9]/, '숫자 포함')
      .regex(/[^A-Za-z0-9]/, '특수문자 포함'),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, {
    message: '비밀번호가 일치하지 않습니다',
    path: ['confirm'],
  });
type PwValues = z.infer<typeof pwSchema>;

function PasswordPanel() {
  const [pending, start] = useTransition();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<PwValues>({
    resolver: zodResolver(pwSchema),
  });

  function onSubmit(values: PwValues) {
    start(async () => {
      const res = await updatePasswordAction({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success('비밀번호가 변경되었습니다');
      reset();
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="curPw" className="text-xs">현재 비밀번호</Label>
        <Input id="curPw" type="password" autoComplete="current-password" {...register('currentPassword')} />
        {errors.currentPassword && <p className="text-xs text-status-error">{errors.currentPassword.message}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor="newPw" className="text-xs">새 비밀번호</Label>
        <Input id="newPw" type="password" autoComplete="new-password" {...register('newPassword')} />
        {errors.newPassword && <p className="text-xs text-status-error">{errors.newPassword.message}</p>}
        <p className="text-[11px] text-txt-muted">12자 이상 · 대문자 · 소문자 · 숫자 · 특수문자 모두 포함</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="newPw2" className="text-xs">새 비밀번호 확인</Label>
        <Input id="newPw2" type="password" autoComplete="new-password" {...register('confirm')} />
        {errors.confirm && <p className="text-xs text-status-error">{errors.confirm.message}</p>}
      </div>
      <Button type="submit" disabled={pending} className="bg-gradient-brand text-white">
        {pending ? '변경 중...' : '비밀번호 변경'}
      </Button>
    </form>
  );
}

// ── Email change ────────────────────────────────────────────────

const emailSchema = z.object({
  newEmail: z.string().email('올바른 이메일 입력'),
});
type EmailValues = z.infer<typeof emailSchema>;

function EmailPanel({ currentEmail }: { currentEmail: string }) {
  const [pending, start] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<EmailValues>({
    resolver: zodResolver(emailSchema),
  });

  function onSubmit(values: EmailValues) {
    start(async () => {
      const res = await updateEmailAction({ newEmail: values.newEmail });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? '확인 메일을 발송했습니다');
      setSentTo(values.newEmail);
      reset();
    });
  }

  if (sentTo) {
    return (
      <div className="rounded-md border border-status-success/30 bg-status-success/5 p-3 text-xs text-txt-secondary">
        <p>
          <span className="font-mono text-txt-primary">{sentTo}</span> 로 확인 메일을
          발송했습니다. 메일의 링크를 클릭한 뒤부터 새 이메일로 로그인할 수 있습니다.
        </p>
        <button
          type="button"
          className="mt-2 text-[11px] text-txt-muted hover:text-txt-primary underline"
          onClick={() => setSentTo(null)}
        >
          다른 이메일로 다시 시도
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <p className="text-xs text-txt-muted">
        현재 이메일: <span className="font-mono text-txt-primary">{currentEmail}</span>
      </p>
      <div className="space-y-1">
        <Label htmlFor="newEmail" className="text-xs">새 이메일</Label>
        <Input id="newEmail" type="email" autoComplete="email" placeholder="new@example.com" {...register('newEmail')} />
        {errors.newEmail && <p className="text-xs text-status-error">{errors.newEmail.message}</p>}
      </div>
      <Button type="submit" disabled={pending} className="bg-gradient-brand text-white">
        {pending ? '발송 중...' : '확인 메일 받기'}
      </Button>
    </form>
  );
}

// ── Account deletion ────────────────────────────────────────────

const deleteSchema = z.object({
  currentPassword: z.string().min(1, '현재 비밀번호 입력'),
  confirmText: z.string(),
});
type DeleteValues = z.infer<typeof deleteSchema>;

function DeletePanel() {
  const [pending, start] = useTransition();
  const { register, handleSubmit, watch, formState: { errors } } = useForm<DeleteValues>({
    resolver: zodResolver(deleteSchema),
  });
  const confirmValue = watch('confirmText') ?? '';
  const canSubmit = confirmValue === '계정 삭제';

  function onSubmit(values: DeleteValues) {
    start(async () => {
      const res = await deleteAccountAction({
        currentPassword: values.currentPassword,
        confirmText: values.confirmText,
      });
      if (res?.error) {
        toast.error(res.error);
      }
      // On success the action redirects, so no follow-up needed.
    });
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <p className="text-xs text-status-error">
        ⚠ 계정 삭제는 되돌릴 수 없습니다. 관심 종목·피드백·텔레그램 연동 모두 함께
        삭제됩니다.
      </p>
      <div className="space-y-1">
        <Label htmlFor="delPw" className="text-xs">현재 비밀번호</Label>
        <Input id="delPw" type="password" autoComplete="current-password" {...register('currentPassword')} />
        {errors.currentPassword && <p className="text-xs text-status-error">{errors.currentPassword.message}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor="delConfirm" className="text-xs">
          확인을 위해 <span className="font-mono text-status-error">계정 삭제</span> 입력
        </Label>
        <Input
          id="delConfirm"
          type="text"
          placeholder="계정 삭제"
          autoComplete="off"
          {...register('confirmText')}
        />
      </div>
      <Button
        type="submit"
        disabled={pending || !canSubmit}
        variant="outline"
        className="border-status-error/40 text-status-error hover:bg-status-error/10 hover:text-status-error"
      >
        <Trash2 className="h-4 w-4 mr-1.5" />
        {pending ? '삭제 중...' : '계정 영구 삭제'}
      </Button>
    </form>
  );
}
