'use client';

import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Small client-island back button — works on any page rendered as a Server
 * Component without forcing the whole page to be a client component.
 *
 * Falls back to `fallbackHref` when there's no history entry (deep link
 * landing) so the user is never stranded.
 */
export function BackButton({
  fallbackHref = '/',
  label = '뒤로',
  className,
}: {
  fallbackHref?: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={className ?? 'h-8 px-2 -ml-2 text-txt-secondary hover:text-txt-primary'}
      aria-label={label}
      onClick={() => {
        // history.length ≥ 2 means there's somewhere to go back to. On a
        // fresh tab the only entry is the current page, so we route to
        // `fallbackHref` instead of leaving the user on a dead-end.
        if (typeof window !== 'undefined' && window.history.length > 1) {
          router.back();
        } else {
          router.push(fallbackHref);
        }
      }}
    >
      <ArrowLeft className="h-4 w-4 mr-1" />
      {label}
    </Button>
  );
}
