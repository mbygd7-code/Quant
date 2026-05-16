'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Bell,
  ChartLine,
  ChevronDown,
  Database,
  FlaskConical,
  HelpCircle,
  LineChart,
  LogOut,
  Moon,
  Network,
  Radio,
  Scale,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Sun,
  User,
  Users,
} from 'lucide-react';
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
import { cn } from '@/lib/utils';

type Role = 'user' | 'beta' | 'admin';

interface HeaderProps {
  email: string;
  role: Role;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Role[];
}

// Primary nav — rendered inline in the GNB. Trimmed to the high-traffic
// surfaces; everything else (signals, reports, admin tools) lives in the
// Settings dropdown below.
const PRIMARY_NAV: NavItem[] = [
  { href: '/stocks/kr', label: '국내주식',         icon: LineChart, roles: ['admin'] },
  { href: '/realtime',  label: '실시간 미국주식',  icon: Radio,     roles: ['user', 'beta', 'admin'] },
];

// Settings dropdown — user-level pages (Settings, AI 가중치, AI 시그널,
// Reports) on top, then admin-only tools below a separator.
const SETTINGS_NAV: NavItem[] = [
  { href: '/settings',                 label: 'Settings',     icon: SettingsIcon,      roles: ['user', 'beta', 'admin'] },
  { href: '/settings/agent-weights',   label: 'AI 가중치',     icon: SlidersHorizontal, roles: ['user', 'beta', 'admin'] },
  { href: '/agent-signals',            label: 'AI 시그널',     icon: Activity,          roles: ['user', 'beta', 'admin'] },
  { href: '/reports',                  label: 'Reports',      icon: ChartLine,         roles: ['user', 'beta', 'admin'] },
  { href: '/mapping',                  label: 'Mapping',      icon: Network,           roles: ['admin'] },
  { href: '/knowledge',                label: 'Knowledge',    icon: Database,          roles: ['admin'] },
  { href: '/weights',                  label: 'Weights',      icon: Scale,             roles: ['admin'] },
  { href: '/backtest',                 label: 'Backtest',     icon: FlaskConical,      roles: ['admin'] },
  { href: '/admin/users',              label: 'Users',        icon: Users,             roles: ['admin'] },
  { href: '/admin/data-quality',       label: 'Data Quality', icon: LineChart,         roles: ['admin'] },
  { href: '/admin/agent-monitoring',   label: 'AI 모니터링',   icon: Activity,          roles: ['admin'] },
  { href: '/admin/notifications',      label: 'Notifications',icon: Bell,              roles: ['admin'] },
];

export function Header({ email, role }: HeaderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, toggleTheme } = useTheme();

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    toast.success('로그아웃 완료');
    router.replace('/login');
    router.refresh();
  }

  const primaryVisible = PRIMARY_NAV.filter((i) => i.roles.includes(role));
  const settingsVisible = SETTINGS_NAV.filter((i) => i.roles.includes(role));
  const settingsActive = settingsVisible.some(
    (i) => pathname === i.href || pathname.startsWith(`${i.href}/`),
  );

  return (
    <header
      className="flex items-center h-14 px-4 md:px-6 border-b border-border-divider gap-2"
      style={{ background: 'var(--bg-primary)' }}
    >
      <div className="flex items-center gap-2">
        <MobileSidebar role={role} />
        <div className="md:hidden flex items-center gap-2">
          <div className="h-7 w-7 sidebar-symbol" />
          <span className="font-heading text-sm font-semibold">QuantSignal</span>
        </div>
      </div>

      {/* Primary nav — hidden on small screens, MobileSidebar handles those. */}
      <nav className="hidden md:flex items-center gap-0.5">
        {primaryVisible.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex items-center gap-1.5 px-3 h-9 rounded-md text-[13px] font-medium transition-colors',
                active
                  ? 'bg-[var(--sidebar-active-bg)] text-brand-purple'
                  : 'text-txt-secondary hover:text-txt-primary hover:bg-[var(--sidebar-hover)]',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{item.label}</span>
            </Link>
          );
        })}

        {/* Settings dropdown */}
        {settingsVisible.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1.5 px-3 h-9 rounded-md text-[13px] font-medium transition-colors',
                  settingsActive
                    ? 'bg-[var(--sidebar-active-bg)] text-brand-purple'
                    : 'text-txt-secondary hover:text-txt-primary hover:bg-[var(--sidebar-hover)]',
                )}
              >
                <SettingsIcon className="h-4 w-4 shrink-0" />
                <span>Settings</span>
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              {settingsVisible.map((item, idx) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                // Insert a separator at the user→admin boundary. An item is
                // "admin-only" when its `roles` list has exactly one entry
                // (just 'admin'); the divider appears at the first such row.
                const prev = idx > 0 ? settingsVisible[idx - 1] : null;
                const showSeparator =
                  idx > 0 &&
                  item.roles.length === 1 &&
                  prev !== null &&
                  prev.roles.length > 1;
                return (
                  <span key={item.href}>
                    {showSeparator && <DropdownMenuSeparator />}
                    <DropdownMenuItem asChild>
                      <Link
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2 cursor-pointer',
                          active && 'text-brand-purple',
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        <span>{item.label}</span>
                      </Link>
                    </DropdownMenuItem>
                  </span>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          asChild
          aria-label="도움말 — 주식 용어 및 차트 사용법"
          title="도움말 — 주식 용어 / 차트 / 거래량 / AI 시그널 안내"
        >
          <Link href="/help">
            <HelpCircle className="h-4 w-4" />
          </Link>
        </Button>
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
