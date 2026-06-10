'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCcw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { resetPaperPortfolioAction } from '@/app/actions/paper';

const PRESETS = [10_000_000, 50_000_000, 100_000_000, 500_000_000];

/**
 * Capital editor. Changing the amount is a RESET (wipes trades/positions/
 * snapshots) — mid-run capital edits would corrupt the P&L audit, so the
 * dialog says exactly that and requires explicit confirmation.
 */
export function PaperSettings({
  currentCapital,
  startedAt,
}: {
  currentCapital: number;
  startedAt: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [capital, setCapital] = useState<number>(currentCapital);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await resetPaperPortfolioAction({ capital });
      if (res.error) {
        toast.error(`초기화 실패: ${res.error}`);
        return;
      }
      toast.success(
        `모의투자 초기화 완료 — 새 자본 ${capital.toLocaleString('ko-KR')}원. 다음 분석 사이클부터 매매가 다시 시작됩니다.`,
      );
      setOpen(false);
      setConfirming(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setConfirming(false);
          setCapital(currentCapital);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs">
          <Settings2 className="h-3.5 w-3.5 mr-1.5" />
          자본 설정
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">가상 자본 설정</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-[12px] text-txt-secondary leading-relaxed">
            운용 시작: {startedAt.slice(0, 10)} · 현재 초기자본{' '}
            <b className="tabular-nums">{currentCapital.toLocaleString('ko-KR')}원</b>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setCapital(p)}
                className={`rounded-full border px-3 py-1 text-[12px] transition-colors ${
                  capital === p
                    ? 'border-brand-purple bg-brand-purple/10 text-txt-primary'
                    : 'border-border-subtle text-txt-secondary hover:text-txt-primary'
                }`}
              >
                {p >= 100_000_000 ? `${p / 100_000_000}억` : `${p / 10_000_000}천만`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1_000_000}
              step={1_000_000}
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value))}
              className="h-9 text-sm tabular-nums"
            />
            <span className="text-sm text-txt-muted shrink-0">원</span>
          </div>
          {!confirming ? (
            <Button
              className="w-full h-9 text-sm"
              variant="destructive"
              onClick={() => setConfirming(true)}
              disabled={pending || !Number.isFinite(capital) || capital < 1_000_000}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              이 금액으로 초기화
            </Button>
          ) : (
            <div className="rounded-md border border-status-error/40 bg-status-error/5 p-3 space-y-2">
              <p className="text-[12px] leading-relaxed">
                <b>경고:</b> 자본 변경은 포트폴리오 <b>초기화</b>입니다. 지금까지의 거래내역·보유
                종목·자산 곡선이 모두 삭제되고{' '}
                <b className="tabular-nums">{capital.toLocaleString('ko-KR')}원</b>
                에서 새로 시작합니다. 되돌릴 수 없습니다.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={submit}
                  disabled={pending}
                >
                  {pending ? '초기화 중…' : '확인 — 초기화 실행'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setConfirming(false)}
                  disabled={pending}
                >
                  취소
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
