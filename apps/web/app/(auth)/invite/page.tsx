import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function InviteIndexPage() {
  return (
    <div className="rounded-xl border border-border bg-bg-secondary/90 backdrop-blur p-8 shadow-lg fade-in space-y-4">
      <h1 className="font-heading text-xl font-semibold">초대 가입</h1>
      <p className="text-sm text-txt-secondary">
        관리자가 보낸 초대 메일의 링크를 통해서만 가입이 가능합니다. 메일을 확인해 주세요.
      </p>
      <Button asChild variant="outline" className="w-full">
        <Link href="/login">로그인 페이지로 돌아가기</Link>
      </Button>
    </div>
  );
}
