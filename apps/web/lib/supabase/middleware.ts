import { createServerClient } from '@supabase/ssr';
import { createClient as createAdminSupabase } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

const ADMIN_PREFIXES = ['/mapping', '/knowledge', '/weights', '/backtest', '/admin'];

// Routes accessible without a session.
const PUBLIC_PREFIXES = [
  '/login',
  '/signup',
  '/invite',
  '/forgot-password',
  '/reset-password',
  '/terms',
  '/privacy',
  '/api/auth',
  '/api/dev-login',
  '/api/dev-whoami',
];

// Routes a logged-in but un-approved user is allowed to visit.
// Anything else bounces to /pending until admin approval lands.
const PENDING_ALLOWED_PREFIXES = [
  '/pending',
  '/api/auth',
  '/logout',
  '/terms',
  '/privacy',
];

export async function updateSession(request: NextRequest) {
  // Dev escape hatch: skip all auth gating when DEV_BYPASS_AUTH is set.
  if (process.env.DEV_BYPASS_AUTH === 'true') {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const { data: { user } } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((p) => path.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  // Already-logged-in user hits a pure auth page → push to dashboard.
  // /pending stays accessible because they may still need to see it.
  if (user && (path === '/login' || path === '/signup' || path.startsWith('/invite'))) {
    const url = request.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  // Approval + role checks both need the profiles row. Read it once
  // with service_role to bypass the recursive RLS policy
  // (admin_read_all_profiles references profiles in its USING clause).
  if (user) {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let approval: string | null = null;
    let role: string | null = null;
    if (serviceRoleKey) {
      const adminClient = createAdminSupabase(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        serviceRoleKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { data: profile } = await adminClient
        .from('profiles')
        .select('role, approval_status')
        .eq('id', user.id)
        .maybeSingle();
      approval = profile?.approval_status ?? null;
      role = profile?.role ?? null;
    } else {
      const { data: profile } = await supabase
        .from('profiles')
        .select('role, approval_status')
        .eq('id', user.id)
        .maybeSingle();
      approval = profile?.approval_status ?? null;
      role = profile?.role ?? null;
    }

    // Pending / rejected / expired users may only see /pending and a
    // handful of safe pages.
    if (approval && approval !== 'approved') {
      const allowed = PENDING_ALLOWED_PREFIXES.some((p) => path.startsWith(p));
      if (!allowed) {
        const url = request.nextUrl.clone();
        url.pathname = '/pending';
        return NextResponse.redirect(url);
      }
    }

    // Approved users — enforce admin-only prefixes.
    if (approval === 'approved' && ADMIN_PREFIXES.some((p) => path.startsWith(p))) {
      if (role !== 'admin') {
        const url = request.nextUrl.clone();
        url.pathname = '/dashboard';
        return NextResponse.redirect(url);
      }
    }
  }

  return response;
}
