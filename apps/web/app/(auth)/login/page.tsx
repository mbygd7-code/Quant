import { LoginForm } from '@/components/auth/login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 h-12 w-12 sidebar-symbol" />
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          QuantSignal
        </h1>
        <p className="mt-1 text-sm text-txt-secondary">
          글로벌 선행 신호를 한국 관심종목에 번역해 드립니다
        </p>
      </div>
      {error && (
        <div className="mb-4 rounded-md border border-status-error/30 bg-status-error/10 px-3 py-2 text-xs text-status-error">
          로그인 실패: {decodeURIComponent(error)}
        </div>
      )}
      <LoginForm />
      <p className="mt-6 text-center text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}
