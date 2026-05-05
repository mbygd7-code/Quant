import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { DevBypassBanner } from '@/components/layout/dev-bypass-banner';

type Role = 'user' | 'beta' | 'admin';

const DEV_BYPASS = process.env.DEV_BYPASS_AUTH === 'true';

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let role: Role = 'admin';
  let email = 'dev@local';

  if (!DEV_BYPASS) {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) redirect('/login');

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, email')
      .eq('id', user.id)
      .maybeSingle();

    role = ((profile?.role as Role) ?? 'user') as Role;
    email = profile?.email ?? user.email ?? '';
  }

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
