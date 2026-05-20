import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        // PKCE로 고정. 회원가입 confirm / 비밀번호 재설정 메일 링크가
        // `?code=...` 형식이라 exchangeCodeForSession이 필요한데, 이때
        // verifier가 쿠키에 저장돼 있어야 서버 callback에서 교환 성공.
        // signInWithPassword는 PKCE를 사용하지 않으므로 로그인엔 영향 없음.
        flowType: 'pkce',
      },
    },
  );
}
