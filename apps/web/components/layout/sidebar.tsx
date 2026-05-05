'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BarChart3,
  Bell,
  ChartLine,
  Database,
  FlaskConical,
  Layers3,
  LineChart,
  ListTodo,
  Network,
  Scale,
  Settings,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

type Role = 'user' | 'beta' | 'admin';

interface Item {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Role[];
}

const NAV: Array<{ section: string; items: Item[] }> = [
  {
    section: '내 대시보드',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: BarChart3, roles: ['user', 'beta', 'admin'] },
      { href: '/watchlist', label: 'Watchlist', icon: ListTodo, roles: ['user', 'beta', 'admin'] },
      { href: '/reports', label: 'Reports', icon: ChartLine, roles: ['user', 'beta', 'admin'] },
      { href: '/settings', label: 'Settings', icon: Settings, roles: ['user', 'beta', 'admin'] },
    ],
  },
  {
    section: 'Admin',
    items: [
      { href: '/mapping', label: 'Mapping', icon: Network, roles: ['admin'] },
      { href: '/knowledge', label: 'Knowledge', icon: Database, roles: ['admin'] },
      { href: '/weights', label: 'Weights', icon: Scale, roles: ['admin'] },
      { href: '/backtest', label: 'Backtest', icon: FlaskConical, roles: ['admin'] },
      { href: '/admin/users', label: 'Users', icon: Users, roles: ['admin'] },
      { href: '/admin/data-quality', label: 'Data Quality', icon: LineChart, roles: ['admin'] },
      { href: '/admin/notifications', label: 'Notifications', icon: Bell, roles: ['admin'] },
    ],
  },
];

export function Sidebar({ role, variant = 'desktop' }: { role: Role; variant?: 'desktop' | 'sheet' }) {
  const pathname = usePathname();
  const wrapperClass =
    variant === 'sheet'
      ? 'flex h-full flex-col w-full'
      : 'hidden md:flex flex-col w-[192px] shrink-0 border-r border-border-divider';

  return (
    <aside
      className={wrapperClass}
      style={{ background: 'var(--sidebar-bg)' }}
    >
      <div className="flex items-center gap-2 px-4 h-14 border-b border-border-divider">
        <div className="h-7 w-7 sidebar-symbol" />
        <span className="font-heading text-base font-semibold tracking-tight">QuantSignal</span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 space-y-5">
        {NAV.map((group) => {
          const visible = group.items.filter((i) => i.roles.includes(role));
          if (visible.length === 0) return null;
          return (
            <div key={group.section}>
              <p className="px-4 mb-1.5 text-[10px] uppercase tracking-wider text-txt-muted font-medium">
                {group.section}
              </p>
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'flex items-center gap-2.5 mx-2 px-2 h-9 rounded-sm text-sm transition-colors',
                          active
                            ? 'bg-[var(--sidebar-active-bg)] text-brand-purple'
                            : 'text-txt-secondary hover:text-txt-primary hover:bg-[var(--sidebar-hover)]',
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="px-4 py-3 text-[10px] text-txt-muted border-t border-border-divider">
        <Layers3 className="inline h-3 w-3 mr-1" />
        v0.1 · 매매 권유 아님
      </div>
    </aside>
  );
}
