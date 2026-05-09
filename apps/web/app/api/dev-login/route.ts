import { NextResponse } from 'next/server';
import { createClient as createServerSupabase } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';

const DEV_PASSWORD = 'dev-password-12345!';

function devEmail(idx: number) {
  return `dev${idx}@quantsignal.local`;
}

function devName(idx: number) {
  return `Dev User ${idx}`;
}

export async function POST(request: Request) {
  // Production에서는 절대 동작하지 않도록 차단.
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'dev-login disabled in production' }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { index?: unknown };
  const index = Number(body.index);

  if (!Number.isInteger(index) || index < 1 || index > 5) {
    return NextResponse.json({ error: 'index must be 1..5' }, { status: 400 });
  }

  const email = devEmail(index);

  // 1) Admin 클라이언트로 dev 유저 보장 (없으면 생성, 있으면 password 동기화).
  const admin = createAdminClient();

  // 기존 유저 조회. listUsers는 페이지네이션을 지원하지만 dev 환경 + 5명 한정이라 첫 페이지로 충분.
  const { data: list, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) {
    return NextResponse.json({ error: `listUsers: ${listError.message}` }, { status: 500 });
  }

  const existing = list.users.find((u) => u.email === email);
  let userId: string;

  if (!existing) {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password: DEV_PASSWORD,
      email_confirm: true,
      user_metadata: {
        display_name: devName(index),
        dev_account: true,
        dev_index: index,
        role: 'admin',
      },
    });
    if (createError || !created.user) {
      return NextResponse.json(
        { error: `createUser: ${createError?.message ?? 'unknown'}` },
        { status: 500 },
      );
    }
    userId = created.user.id;
  } else {
    // 비밀번호가 바뀌었거나 기존 OTP-only 유저인 경우 동기화 + admin 메타데이터 보장.
    const { error: updateError } = await admin.auth.admin.updateUserById(existing.id, {
      password: DEV_PASSWORD,
      email_confirm: true,
      user_metadata: {
        ...existing.user_metadata,
        display_name: devName(index),
        dev_account: true,
        dev_index: index,
        role: 'admin',
      },
    });
    if (updateError) {
      return NextResponse.json({ error: `updateUser: ${updateError.message}` }, { status: 500 });
    }
    userId = existing.id;
  }

  // 1.5) profiles 테이블에 admin 역할 강제 동기화.
  // handle_new_user 트리거가 ON CONFLICT DO NOTHING으로 role='user' 행을 미리 만들 수 있으므로
  // upsert만으로는 부족할 수 있다 → upsert 후 명시적 update로 role을 admin으로 강제.
  const { error: upsertError } = await admin.from('profiles').upsert(
    {
      id: userId,
      email,
      display_name: devName(index),
      role: 'admin',
    },
    { onConflict: 'id' },
  );
  if (upsertError) {
    return NextResponse.json(
      { error: `upsertProfile: ${upsertError.message}` },
      { status: 500 },
    );
  }

  const { error: roleError } = await admin
    .from('profiles')
    .update({ role: 'admin', display_name: devName(index) })
    .eq('id', userId);
  if (roleError) {
    return NextResponse.json(
      { error: `forceAdminRole: ${roleError.message}` },
      { status: 500 },
    );
  }

  // 검증용으로 실제 저장된 profile을 다시 읽어 응답에 포함.
  const { data: profile, error: readError } = await admin
    .from('profiles')
    .select('id, email, role, display_name')
    .eq('id', userId)
    .maybeSingle();

  // 2) 서버 SSR 클라이언트로 비밀번호 로그인 → 세션 쿠키 자동 설정.
  const supabase = await createServerSupabase();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: DEV_PASSWORD,
  });
  if (signInError) {
    return NextResponse.json({ error: `signIn: ${signInError.message}` }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    email,
    profile: profile ?? null,
    readError: readError?.message ?? null,
  });
}
