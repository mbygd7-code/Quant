import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        // PKCE를 끔. 6자리 OTP 코드 흐름엔 verifier 불필요하고,
        // PKCE 활성 시 verifier 저장 실패가 send 자체를 막는 케이스가 있어 implicit으로 고정.
        flowType: 'implicit',
      },
    },
  );
}
