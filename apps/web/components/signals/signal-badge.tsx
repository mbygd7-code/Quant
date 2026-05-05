import { cn } from '@/lib/utils';
import { SIGNAL_TONE } from '@/lib/format';
import type { Signal } from '@/lib/types';

export function SignalBadge({ signal, className }: { signal: Signal | null; className?: string }) {
  if (!signal) {
    return (
      <span className={cn('inline-flex items-center px-2 py-0.5 text-[11px] rounded-sm bg-bg-tertiary text-txt-muted border border-border', className)}>
        —
      </span>
    );
  }
  const tone = SIGNAL_TONE[signal];
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 text-[11px] rounded-sm font-medium', tone.pillBg, className)}>
      {tone.label}
    </span>
  );
}
