'use client';

import { useState } from 'react';
import { ReceiptText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Per-trade / per-order "왜?" button — opens a dialog with the full
 * decision record: which signal triggered it, why THIS amount
 * (확신도×역변동성 사이징 내역), execution costs, and realized P&L.
 * Everything shown is read straight from the immutable ledger row, so
 * the explanation can never drift from what actually happened.
 */

export interface TradeDetailData {
  kind: 'trade' | 'order';
  name: string;
  ticker: string;
  side: 'buy' | 'sell';
  date: string; // trade_date or order_date
  qty?: number | null;
  price?: number | null;
  amount?: number | null;
  fee?: number | null;
  tax?: number | null;
  budget?: number | null; // pending buy orders
  signal_grade?: string | null;
  weighted_score?: number | null;
  reason?: string | null;
  realized_pnl?: number | null;
}

const GRADE_LABEL: Record<string, string> = {
  STRONG_BUY: '강한 관심',
  BUY: '관심',
  HOLD: '관망',
  CAUTION: '주의',
  RISK: '위험',
};

const krw = (v: number | null | undefined) =>
  v == null ? '—' : `${Math.round(v).toLocaleString('ko-KR')}원`;

/** Pull the sizing components out of the stored reason string, e.g.
 *  "BUY 진입 — 확신도×역변동성 사이징 12.0% (점수 0.65, 합의 74%, σ 4.5%)" */
function parseSizing(reason: string | null | undefined) {
  if (!reason) return null;
  const m = reason.match(
    /사이징\s*([\d.]+)%\s*\(점수\s*([-\d.]+),\s*합의\s*(\d+)%,\s*σ\s*([\d.]+)%\)/,
  );
  if (!m) return null;
  return { weightPct: m[1], score: m[2], consensusPct: m[3], sigmaPct: m[4] };
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border-subtle/40 last:border-0">
      <span className="text-[11px] text-txt-muted shrink-0 pt-0.5">{label}</span>
      <span className="text-[13px] text-right">{children}</span>
    </div>
  );
}

export function TradeDetailButton({ data }: { data: TradeDetailData }) {
  const [open, setOpen] = useState(false);
  const sizing = parseSizing(data.reason);
  const isBuy = data.side === 'buy';
  const isStop = (data.reason ?? '').includes('손절');
  const isDowngrade = (data.reason ?? '').includes('신호 하향');

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-txt-muted hover:text-txt-primary"
        title="이 거래의 결정 근거 보기"
        onClick={() => setOpen(true)}
      >
        <ReceiptText className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <span
                className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                  isBuy
                    ? 'bg-status-success/10 text-status-success'
                    : 'bg-status-error/10 text-status-error'
                }`}
              >
                {isBuy ? '매수' : '매도'}
                {data.kind === 'order' ? ' 대기' : ''}
              </span>
              {data.name}
              <span className="text-[11px] font-normal text-txt-muted">{data.ticker}</span>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            {/* ── 왜 이 거래를 했나 ── */}
            <div className="rounded-md border border-border-subtle/60 bg-bg-secondary/30 p-3">
              <div className="text-[11px] font-semibold text-txt-secondary mb-1">
                {isBuy ? '왜 샀나' : '왜 팔았나'}
              </div>
              <p className="text-[13px] leading-relaxed whitespace-pre-line">
                {data.reason ?? '기록된 사유 없음'}
              </p>
              {data.signal_grade && (
                <p className="mt-1.5 text-[12px] text-txt-secondary">
                  트리거 신호:{' '}
                  <b>
                    {GRADE_LABEL[data.signal_grade] ?? data.signal_grade}
                  </b>
                  {data.weighted_score != null && (
                    <> · 가중점수 {Number(data.weighted_score).toFixed(2)} (범위 −2~+2)</>
                  )}
                </p>
              )}
              {isStop && (
                <p className="mt-1 text-[11px] text-status-warning">
                  손절 규칙: 평단 대비 −10% 도달 시 자동 청산 — 큰 손실 꼬리를 잘라 복리를
                  지키는 리스크 관리 규칙입니다.
                </p>
              )}
              {isDowngrade && (
                <p className="mt-1 text-[11px] text-txt-muted">
                  청산 규칙: 보유 종목의 AI 합의 등급이 주의/위험으로 하향되면 전량 매도합니다.
                </p>
              )}
            </div>

            {/* ── 왜 이 금액인가 (매수 사이징 분해) ── */}
            {isBuy && sizing && (
              <div className="rounded-md border border-brand-purple/30 bg-brand-purple/5 p-3">
                <div className="text-[11px] font-semibold text-txt-secondary mb-1.5">
                  왜 이 금액인가 — 확신도 × 역변동성 사이징
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
                  <span className="text-txt-muted">목표 비중</span>
                  <b className="text-right tabular-nums">자산의 {sizing.weightPct}%</b>
                  <span className="text-txt-muted">신호 점수</span>
                  <b className="text-right tabular-nums">{sizing.score} / ±2</b>
                  <span className="text-txt-muted">전문가 합의율</span>
                  <b className="text-right tabular-nums">{sizing.consensusPct}%</b>
                  <span className="text-txt-muted">일변동성 σ</span>
                  <b className="text-right tabular-nums">{sizing.sigmaPct}%</b>
                </div>
                <p className="mt-2 text-[11px] text-txt-muted leading-relaxed">
                  확신이 강할수록(점수·합의율↑) 크게, 변동성이 클수록(σ↑) 작게 — 한 종목의
                  나쁜 하루가 자산의 1.5% 이상을 잃지 않도록 변동성 상한, 단일 종목 최대 20%,
                  섹터 최대 40% 한도가 함께 적용됐습니다.
                </p>
              </div>
            )}

            {/* ── 체결/주문 내역 ── */}
            <div>
              <Row label="일자">{data.date}</Row>
              {data.kind === 'order' ? (
                <>
                  {isBuy && <Row label="예약 예산">{krw(data.budget)}</Row>}
                  {!isBuy && <Row label="매도 수량">{(data.qty ?? 0).toLocaleString()}주</Row>}
                  <Row label="체결 방식">다음 시가(09:00) ±0.05% 슬리피지</Row>
                </>
              ) : (
                <>
                  <Row label="체결">
                    {(data.qty ?? 0).toLocaleString()}주 × {krw(data.price)}
                  </Row>
                  <Row label="거래대금">{krw(data.amount)}</Row>
                  <Row label="비용 (수수료/세금)">
                    {krw((data.fee ?? 0) + (data.tax ?? 0))}
                    <span className="text-[11px] text-txt-muted ml-1">
                      (수수료 {krw(data.fee)}
                      {(data.tax ?? 0) > 0 ? ` + 거래세 ${krw(data.tax)}` : ''})
                    </span>
                  </Row>
                  {!isBuy && data.realized_pnl != null && (
                    <Row label="실현손익 (비용 차감 후)">
                      <b
                        className={
                          data.realized_pnl >= 0 ? 'text-status-success' : 'text-status-error'
                        }
                      >
                        {data.realized_pnl >= 0 ? '+' : ''}
                        {Math.round(data.realized_pnl).toLocaleString('ko-KR')}원
                      </b>
                    </Row>
                  )}
                </>
              )}
            </div>

            <p className="text-[10px] text-txt-muted">
              모든 항목은 거래 시점에 기록된 원장에서 그대로 읽어옵니다 (사후 수정 불가). 가상
              자금 시뮬레이션이며 매매 권유가 아닙니다.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
