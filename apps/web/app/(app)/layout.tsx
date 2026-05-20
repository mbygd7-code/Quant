import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { DevBypassBanner } from '@/components/layout/dev-bypass-banner';

type Role = 'user' | 'beta' | 'admin';

// DEV_BYPASS_AUTH only suppresses the redirect to /login if there's no
// session — it must NEVER fake a user. The layout always reads the real
// session so a leaked env var in production can't mask the logged-in
// account as "dev@local".
const DEV_BYPASS = process.env.DEV_BYPASS_AUTH === 'true';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    if (DEV_BYPASS) {
      // Local dev without a session — render with a placeholder. In prod
      // this branch can't fire because middleware would have redirected.
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

  const role: Role = ((profile?.role as Role) ?? 'user') as Role;
  const email = profile?.email ?? user.email ?? '';

  return (
    <div className="flex h-screen content-gradient-bg">
      <Sidebar role={role} />
      <div className="flex-1 flex flex-col min-w-0">
        <Header email={email} role={role} />
        {DEV_BYPASS && <DevBypassBanner />}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
