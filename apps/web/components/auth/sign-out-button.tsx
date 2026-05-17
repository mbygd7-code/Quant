'use client';

import { useTransition } from 'react';
import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { signOutAction } from '@/app/actions/auth';

export function SignOutButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() => start(() => signOutAction())}
      className="text-xs text-txt-muted hover:text-txt-primary"
    >
      <LogOut className="h-3.5 w-3.5 mr-1.5" />
      {pending ? '로그아웃 중...' : '로그아웃'}
    </Button>
  );
}
