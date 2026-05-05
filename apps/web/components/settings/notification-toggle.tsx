'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';

import { setNotificationEnabled } from '@/app/actions/settings';
import { cn } from '@/lib/utils';

export function NotificationToggle({ initial }: { initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    startTransition(async () => {
      const res = await setNotificationEnabled(next);
      if (res.error) {
        setEnabled(!next);
        toast.error(res.error);
      } else {
        toast.success(next ? '일일 프리뷰 알림 ON' : '일일 프리뷰 알림 OFF');
      }
    });
  }

  return (
    <label className="flex items-center justify-between gap-4 cursor-pointer select-none">
      <span className="text-sm">
        일일 프리뷰 알림 <span className="text-txt-muted">(06:30 KST)</span>
      </span>
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={enabled}
        className={cn(
          'relative h-6 w-11 rounded-full transition-colors',
          enabled ? 'bg-brand-purple' : 'bg-bg-tertiary border border-border',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform',
            enabled ? 'translate-x-[22px]' : 'translate-x-0.5',
          )}
        />
      </button>
    </label>
  );
}
