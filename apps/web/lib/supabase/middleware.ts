import { createServerClient } from '@supabase/ssr';
import { createClient as createAdminSupabase } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

const ADMIN_PREFIXES = ['/mapping', '/knowledge', '/weights', '/backtest', '/admin'];
const PUBLIC_PREFIXES = [
  '/login',
  '/invite',
  '/api/auth',
  '/api/dev-login',
  '/api/dev-whoami',
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

  if (user && ADMIN_PREFIXES.some((p) => path.startsWith(p))) {
    // profiles 테이블의 RLS 정책(admin_read_all_profiles)이 자기 자신을 EXISTS로 참조해
    // anon 컨텍스트에서 무한 재귀 에러를 일으킨다. 본인 role 한 줄을 읽을 뿐이므로
    // service_role 클라이언트로 RLS를 우회한다 (CLAUDE.md §G — 서버 환경에서 허용).
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let role: string | null = null;
    if (serviceRoleKey) {
      const adminClient = createAdminSupabase(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        serviceRoleKey,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { data: profile } = await adminClient
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();
      role = profile?.role ?? null;
    } else {
      // service_role 없으면 anon 시도 (RLS 재귀 fix 후엔 이 경로가 정상이다).
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .maybeSingle();
      role = profile?.role ?? null;
    }

    if (role !== 'admin') {
      const url = request.nextUrl.clone();
      url.pathname = '/dashboard';
      return NextResponse.redirect(url);
    }
  }

  return response;
}
