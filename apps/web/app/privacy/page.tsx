import Link from 'next/link';

/**
 * Privacy Policy placeholder.
 *
 * Per planning spec, ships with placeholder copy until legal review.
 * The /signup form links here as a target=_blank.
 */
export const metadata = {
  title: '개인정보처리방침 — QuantSignal',
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-bg-primary px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <Link href="/" className="text-xs text-txt-muted hover:text-txt-primary">
          ← QuantSignal
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          개인정보처리방침
        </h1>
        <div className="rounded-md border border-border bg-bg-secondary/60 p-4 text-sm text-txt-secondary leading-relaxed">
          <p className="text-xs uppercase tracking-wider text-txt-muted mb-2">
            Placeholder — 추후 법무 검토 후 교체
          </p>
          <p>
            QuantSignal은 다음 정보를 수집합니다:
          </p>
          <ul className="mt-3 list-disc pl-5 space-y-1.5">
            <li>이메일 주소 (가입·로그인·알림 발송 용도)</li>
            <li>비밀번호 (Supabase가 안전하게 해시 처리)</li>
            <li>관심 종목 리스트 (서비스 핵심 기능)</li>
            <li>피드백 점수 (서비스 개선 용도)</li>
            <li>텔레그램 chat_id (텔레그램 알림 연동 시에만)</li>
          </ul>
          <p className="mt-4">
            수집한 정보는 다음 목적에만 사용됩니다:
          </p>
          <ul className="mt-3 list-disc pl-5 space-y-1.5">
            <li>일일 시그널 리포트 발송</li>
            <li>관심 종목별 맞춤 분석 제공</li>
            <li>서비스 품질 개선</li>
          </ul>
          <p className="mt-4">
            제3자에게 정보를 판매하거나 공유하지 않습니다. 사용자는 언제든지
            <Link href="/settings" className="text-txt-primary underline">
              설정 페이지
            </Link>
            에서 본인 계정을 삭제할 수 있습니다.
          </p>
          <p className="mt-4 text-[11px] text-txt-muted">
            본 방침은 임시본이며, 정식 방침은 추후 업데이트됩니다.
          </p>
        </div>
      </div>
    </div>
  );
}
