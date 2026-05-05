'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Copy } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createInvite } from '@/app/(admin)/admin/users/actions';

const schema = z.object({
  email: z.string().email('올바른 이메일을 입력해주세요'),
  role: z.enum(['admin', 'beta', 'user']),
});
type Values = z.infer<typeof schema>;

export function InviteUserDialog({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [issued, setIssued] = useState<{ url: string; sent: boolean; warning?: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', role: 'beta' },
  });
  const role = form.watch('role');

  function onSubmit(values: Values) {
    startTransition(async () => {
      const res = await createInvite(values);
      if (res.error) {
        toast.error(`초대 실패: ${res.error}`);
        return;
      }
      setIssued({
        url: res.invite_url ?? '',
        sent: !!res.email_sent,
        warning: res.warning,
      });
      router.refresh();
      if (res.email_sent) toast.success(`${values.email}로 초대 메일 발송됨`);
      else toast.warning('이메일 발송 실패 — 링크를 직접 공유하세요');
    });
  }

  function copyLink() {
    if (!issued?.url) return;
    navigator.clipboard.writeText(issued.url).then(
      () => toast.success('링크 복사됨'),
      () => toast.error('복사 실패'),
    );
  }

  function reset() {
    form.reset();
    setIssued(null);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>베타 사용자 초대</DialogTitle>
          <DialogDescription>
            이메일로 7일간 유효한 초대 링크를 발급합니다.
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border bg-bg-tertiary/40 p-3 space-y-2">
              <div className="text-xs text-txt-muted">
                {issued.sent ? '✅ 메일 발송 완료. 링크는 다음과 같습니다:' : '⚠ 메일 발송 실패. 다음 링크를 직접 공유하세요:'}
              </div>
              <div className="flex items-center gap-2">
                <code className="font-mono text-xs break-all flex-1 text-brand-purple">{issued.url}</code>
                <Button size="icon" variant="ghost" onClick={copyLink} aria-label="복사">
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              {issued.warning && (
                <p className="text-[11px] text-status-warning">{issued.warning}</p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>닫기</Button>
              <Button onClick={reset}>다른 사용자 초대</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="email">이메일</Label>
              <Input id="email" type="email" placeholder="user@example.com" {...form.register('email')} />
              {form.formState.errors.email && (
                <p className="text-xs text-status-error">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>권한</Label>
              <Select value={role} onValueChange={(v) => form.setValue('role', v as Values['role'])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">user (기본)</SelectItem>
                  <SelectItem value="beta">beta (50종목)</SelectItem>
                  <SelectItem value="admin">admin (전체 편집권)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>취소</Button>
              <Button type="submit" className="bg-gradient-brand text-white" disabled={pending}>
                {pending ? '발송 중...' : '초대 발송'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
