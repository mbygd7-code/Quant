'use client';

import { useEffect, useState, useTransition } from 'react';
import { Copy, Unlink } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { disconnectTelegram, generateTelegramLinkCode } from '@/app/actions/settings';

interface Props {
  chatId: string | null;
  initialCode: string | null;
  initialExpiresAt: string | null;
}

function maskChatId(chatId: string): string {
  if (chatId.length <= 5) return '***';
  return chatId.slice(0, 3) + '***' + chatId.slice(-2);
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function TelegramLink({ chatId, initialCode, initialExpiresAt }: Props) {
  const [code, setCode] = useState<string | null>(initialCode);
  const [expiresAt, setExpiresAt] = useState<string | null>(initialExpiresAt);
  const [now, setNow] = useState(Date.now());
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  const remainingMs = expiresAt ? new Date(expiresAt).getTime() - now : 0;
  const expired = expiresAt && remainingMs <= 0;

  function handleGenerate() {
    startTransition(async () => {
      const res = await generateTelegramLinkCode();
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setCode(res.code ?? null);
      setExpiresAt(res.expiresAt ?? null);
      toast.success('연동 코드 발급 — 5분 안에 텔레그램에서 사용하세요');
    });
  }

  function handleDisconnect() {
    startTransition(async () => {
      const res = await disconnectTelegram();
      if (res.error) toast.error(res.error);
      else toast.success('텔레그램 연동을 해제했습니다');
    });
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast.success('복사됐습니다'),
      () => toast.error('복사 실패 — 직접 입력해 주세요'),
    );
  }

  if (chatId) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">상태:</span>
          <span className="text-txt-primary text-sm">✓ 연동됨</span>
          <span className="font-mono text-xs text-txt-muted">chat_id {maskChatId(chatId)}</span>
        </div>
        <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={pending}>
          <Unlink className="h-4 w-4 mr-1" />
          연동 해제
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-txt-secondary">
        상태: <span className="text-status-warning">⚠ 미연동</span>
      </div>

      {!code || expired ? (
        <Button
          onClick={handleGenerate}
          disabled={pending}
          className="bg-gradient-brand text-white hover:opacity-90"
        >
          {pending ? '발급 중...' : '연동 코드 발급'}
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-bg-tertiary/40 p-4">
            <div className="text-xs text-txt-muted mb-2">텔레그램 봇에서 다음 명령을 입력하세요:</div>
            <div className="flex items-center gap-3">
              <code className="font-mono text-2xl font-semibold tracking-widest bg-gradient-brand bg-clip-text text-transparent">
                /link {code}
              </code>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => copy(`/link ${code}`)}
                aria-label="복사"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <div className="mt-2 text-xs text-txt-muted">
              남은 시간 <span className="font-mono">{formatRemaining(remainingMs)}</span>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleGenerate} disabled={pending}>
            새 코드 발급
          </Button>
        </div>
      )}
    </div>
  );
}
