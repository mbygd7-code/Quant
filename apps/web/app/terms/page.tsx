import Link from 'next/link';

/**
 * Terms of Service placeholder.
 *
 * Per planning spec, ships with placeholder copy until legal review.
 * The /signup form links here as a target=_blank.
 */
export const metadata = {
  title: '이용약관 — QuantSignal',
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-bg-primary px-4 py-10">
      <div className="mx-auto max-w-2xl space-y-6">
        <Link href="/" className="text-xs text-txt-muted hover:text-txt-primary">
          ← QuantSignal
        </Link>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          이용약관
        </h1>
        <div className="rounded-md border border-border bg-bg-secondary/60 p-4 text-sm text-txt-secondary leading-relaxed">
          <p className="text-xs uppercase tracking-wider text-txt-muted mb-2">
            Placeholder — 추후 법무 검토 후 교체
          </p>
          <p>
            본 서비스(QuantSignal)는 미국 시장 마감 후 한국 시장 시작 전의 글로벌 선행 신호를
            한국 관심 종목 단위로 번역하여 사용자에게 제공하는 투자 판단 보조 자료입니다.
          </p>
          <ul className="mt-4 list-disc pl-5 space-y-1.5">
            <li>본 서비스는 매매 권유가 아니며, 모든 투자 판단의 책임은 사용자에게 있습니다.</li>
            <li>본 서비스는 데이터 정확성을 보장하지 않습니다.</li>
            <li>본 서비스 운영자는 사용자 데이터를 제3자에게 판매하지 않습니다.</li>
            <li>본 약관은 추후 사전 고지 후 변경될 수 있습니다.</li>
          </ul>
          <p className="mt-4 text-[11px] text-txt-muted">
            본 약관은 임시본이며, 정식 약관은 추후 업데이트됩니다.
          </p>
        </div>
      </div>
    </div>
  );
}
