'use client';

import { useState } from 'react';
import { Menu } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Sidebar } from './sidebar';

type Role = 'user' | 'beta' | 'admin';

export function MobileSidebar({ role }: { role: Role }) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="메뉴 열기" className="md:hidden">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="p-0 w-[220px] border-r border-border-divider"
        style={{ background: 'var(--sidebar-bg)' }}
      >
        <SheetTitle className="sr-only">메뉴</SheetTitle>
        <div className="h-full" onClick={() => setOpen(false)}>
          <Sidebar role={role} variant="sheet" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
