'use client';

import { useState } from 'react';
import { Brain, ChevronDown } from 'lucide-react';

const SECTOR_KEYS = ['반도체', '2차전지', '자동차', '바이오/헬스', '인터넷/AI'];

interface PolicyVersion {
  version: number;
  params: {
    grade_mult?: Record<string, number>;
    stop_loss_pct?: number;
    sector_mult?: Record<string, number>;
  };
  notes: string | null;
  n_episodes: number;
  created_at: string;
}

/**
 * Soros 진화 카드 — shows the CURRENT learned trading policy and the
 * version history of how it changed. This is the visible face of the
 * self-improvement loop: every week the learner replays the trade
 * ledger and nudges these numbers (bounded, gated), so the user can
 * watch the bot get smarter from its own results.
 */
export function PolicyCard({ versions }: { versions: PolicyVersion[] }) {
  const [open, setOpen] = useState(false);
  const latest = versions[0];

  if (!latest) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Brain className="h-4 w-4 text-brand-purple" />
          Soros 매매 정책 (진화 중)
        </div>
        <p className="mt-2 text-[12px] text-txt-muted leading-relaxed">
          아직 학습된 정책이 없습니다. 매주 토요일, 누적된 거래 실적(왕복거래)을 분석해 등급별
          신뢰도·손절선·섹터별 가중치를 한도 내에서 조금씩 조정합니다. 거래가 쌓일수록 Soros가
          자신의 성적표로부터 똑똑해집니다.
        </p>
      </div>
    );
  }

  const grade = latest.params.grade_mult ?? {};
  const sector = latest.params.sector_mult ?? {};
  const stop = latest.params.stop_loss_pct ?? -0.1;
  const tunedSectors = SECTOR_KEYS.filter((s) => sector[s] != null);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Brain className="h-4 w-4 text-brand-purple" />
          Soros 매매 정책
          <span className="text-[11px] font-normal text-txt-muted">
            v{latest.version} · 왕복거래 {latest.n_episodes}건 학습
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 text-[11px] text-txt-muted hover:text-txt-primary"
        >
          진화 이력
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* Current learned parameters */}
      <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-[12px]">
        <div title="강한 관심 신호에 부여하는 사이징 신뢰 배수. 실현 승률이 높을수록 1.0에 가까워집니다 (한도 0.30~1.00).">
          <div className="text-[10px] text-txt-muted">강한 관심 신뢰도</div>
          <b className="tabular-nums">{(grade.STRONG_BUY ?? 1.0).toFixed(2)}</b>
        </div>
        <div title="관심 신호 신뢰 배수.">
          <div className="text-[10px] text-txt-muted">관심 신뢰도</div>
          <b className="tabular-nums">{(grade.BUY ?? 0.65).toFixed(2)}</b>
        </div>
        <div title="손절선 — 손절 후 반등(휩쏘)이 잦으면 완화, 추가 하락을 잘 막으면 강화 (한도 -15%~-7%).">
          <div className="text-[10px] text-txt-muted">손절선</div>
          <b className="tabular-nums text-status-error">{(stop * 100).toFixed(0)}%</b>
        </div>
        <div title="섹터별로 학습된 종목선별 가중치 (1.0 중립).">
          <div className="text-[10px] text-txt-muted">학습된 섹터</div>
          <b className="tabular-nums">{tunedSectors.length}개</b>
        </div>
      </div>

      {tunedSectors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tunedSectors.map((s) => {
            const m = sector[s];
            const up = m >= 1.0;
            return (
              <span
                key={s}
                className={`rounded-full border px-2 py-0.5 text-[11px] tabular-nums ${
                  up
                    ? 'border-status-success/40 bg-status-success/10 text-status-success'
                    : 'border-status-error/40 bg-status-error/10 text-status-error'
                }`}
              >
                {s} ×{m.toFixed(2)}
              </span>
            );
          })}
        </div>
      )}

      <p className="mt-2.5 text-[11px] text-txt-muted leading-relaxed">
        {latest.notes || '이번 주 변경 없음 — 표본 부족 또는 파라미터 안정.'}
      </p>

      {/* Version history */}
      {open && versions.length > 1 && (
        <div className="mt-3 border-t border-border-subtle pt-2 space-y-1.5">
          {versions.slice(0, 12).map((v) => (
            <div key={v.version} className="flex items-start gap-2 text-[11px]">
              <span className="text-txt-muted shrink-0 tabular-nums">
                v{v.version} · {v.created_at.slice(0, 10)}
              </span>
              <span className="text-txt-secondary">{v.notes ?? '변경 없음'}</span>
            </div>
          ))}
        </div>
      )}

      <p className="mt-2 text-[10px] text-txt-muted">
        매주 토요일 거래 실적을 분석해 한도 내에서 1스텝씩 조정 — 한 번의 나쁜 주가 정책을
        무너뜨릴 수 없고, 표본이 부족한 항목은 움직이지 않습니다.
      </p>
    </div>
  );
}
