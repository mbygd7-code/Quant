import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { DevBypassBanner } from '@/components/layout/dev-bypass-banner';

// See (app)/layout.tsx for the rationale: real session is always read,
// DEV_BYPASS only affects the unauthenticated-fallback render.
const DEV_BYPASS = process.env.DEV_BYPASS_AUTH === 'true';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    if (DEV_BYPASS) {
      return (
        <div className="flex h-screen content-gradient-bg">
          <Sidebar role="admin" />
          <div className="flex-1 flex flex-col min-w-0">
            <Header email="dev@local" role="admin" />
            <DevBypassBanner />
            <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
          </div>
        </div>
      );
    }
    redirect('/login');
  }

  // profiles RLS 재귀 회피 — service_role로 본인 row만 조회 (CLAUDE.md §G).
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from('profiles')
    .select('role, email')
    .eq('id', user.id)
    .maybeSingle();

  if (profile?.role !== 'admin') redirect('/dashboard');
  const email = profile.email ?? user.email ?? '';

  return (
    <div className="flex h-screen content-gradient-bg">
      <Sidebar role="admin" />
      <div className="flex-1 flex flex-col min-w-0">
        <Header email={email} role="admin" />
        {DEV_BYPASS && <DevBypassBanner />}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
