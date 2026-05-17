'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { reapplyAction } from '@/app/actions/auth';

export function ReapplyButton({ label = '재신청' }: { label?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  function handleClick() {
    start(async () => {
      const res = await reapplyAction();
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success('재신청이 접수되었습니다. 영업일 5일 이내 검토됩니다.');
      router.refresh();
    });
  }

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={pending}
      className="w-full bg-gradient-brand text-white hover:opacity-90"
    >
      <RefreshCw className={'h-4 w-4 mr-2 ' + (pending ? 'animate-spin' : '')} />
      {pending ? '신청 중...' : label}
    </Button>
  );
}
