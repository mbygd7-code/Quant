'use client';

import { useState, useTransition } from 'react';
import { Send } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { sendPreviewNow } from '@/app/(admin)/admin/notifications/actions';

export function SendPreviewButton() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleSend() {
    startTransition(async () => {
      const res = await sendPreviewNow();
      if (res.error) toast.error(`발송 실패: ${res.error}`);
      else toast.success(`발송 완료 — sent ${res.sent ?? 0}, failed ${res.failed ?? 0}`);
      setOpen(false);
    });
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Send className="h-4 w-4 mr-1" />
        지금 수동 발송
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>오늘 프리뷰 즉시 발송</DialogTitle>
            <DialogDescription>
              현재 등록된 모든 chat_id로 오늘의 프리뷰를 즉시 발송합니다.
              06:30 KST 자동 발송과 별개로 추가 발송이 됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>취소</Button>
            <Button
              className="bg-gradient-brand text-white"
              onClick={handleSend}
              disabled={pending}
            >
              {pending ? '발송 중...' : '발송'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
