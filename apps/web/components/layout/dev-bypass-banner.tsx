import { ShieldAlert } from 'lucide-react';

export function DevBypassBanner() {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-[11px] bg-status-warning/15 text-status-warning border-b border-status-warning/30">
      <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
      <span>
        <strong>DEV_BYPASS_AUTH</strong> 모드 — 인증 우회 + Service Role Key로 RLS 우회.
        프로덕션에서는 절대 사용 금지.
      </span>
    </div>
  );
}
