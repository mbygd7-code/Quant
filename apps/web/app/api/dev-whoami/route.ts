import { NextResponse } from 'next/server';
import { createClient as createServerSupabase } from '@/lib/supabase/server';

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'disabled in production' }, { status: 403 });
  }
  const supabase = await createServerSupabase();
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const userId = userData?.user?.id ?? null;
  let profile: unknown = null;
  let profileError: string | null = null;
  if (userId) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, display_name')
      .eq('id', userId)
      .maybeSingle();
    profile = data;
    profileError = error?.message ?? null;
  }
  return NextResponse.json({
    user: userData?.user
      ? { id: userData.user.id, email: userData.user.email }
      : null,
    userError: userError?.message ?? null,
    profile,
    profileError,
  });
}
