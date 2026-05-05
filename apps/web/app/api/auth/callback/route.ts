import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const next = searchParams.get('next') ?? '/dashboard';

  const supabase = await createClient();

  // PKCE flow (default for @supabase/ssr signInWithOtp): ?code=...
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error('[auth/callback] exchangeCodeForSession failed:', error);
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  // Legacy / template-customized flow: ?token_hash=...&type=magiclink
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: type as any,
    });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    console.error('[auth/callback] verifyOtp failed:', error);
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(error.message)}`,
    );
  }

  console.error('[auth/callback] missing code/token_hash. searchParams:',
    Object.fromEntries(searchParams.entries()));
  return NextResponse.redirect(`${origin}/login?error=missing_auth_params`);
}
