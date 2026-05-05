'use client';

import { useRouter } from 'next/navigation';
import { Bell, LogOut, Moon, Sun, User } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/components/theme-provider';
import { MobileSidebar } from '@/components/layout/mobile-sidebar';
import { createClient } from '@/lib/supabase/client';

type Role = 'user' | 'beta' | 'admin';

interface HeaderProps {
  email: string;
  role: Role;
}

export function Header({ email, role }: HeaderProps) {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    toast.success('로그아웃 완료');
    router.replace('/login');
    router.refresh();
  }

  return (
    <header
      className="flex items-center justify-between h-14 px-4 md:px-6 border-b border-border-divider"
      style={{ background: 'var(--bg-primary)' }}
    >
      <div className="flex items-center gap-2">
        <MobileSidebar role={role} />
        <div className="md:hidden flex items-center gap-2">
          <div className="h-7 w-7 sidebar-symbol" />
          <span className="font-heading text-sm font-semibold">QuantSignal</span>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="알림">
          <Bell className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="테마 전환" onClick={toggleTheme}>
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="계정 메뉴">
              <User className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <div className="text-xs text-txt-muted truncate">{email}</div>
              <div className="text-[10px] uppercase tracking-wider text-brand-purple mt-0.5">
                {role}
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={signOut}>
              <LogOut className="h-4 w-4 mr-2" />
              로그아웃
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
