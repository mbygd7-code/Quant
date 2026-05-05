import type { Signal } from '@/lib/types';

export function formatPercent(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(digits)}%`;
}

export function formatPrice(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ko-KR');
}

export function formatScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

export function changeColor(change: number | null | undefined): string {
  if (change == null) return 'text-txt-muted';
  if (change > 0) return 'text-status-success';
  if (change < 0) return 'text-status-error';
  return 'text-txt-secondary';
}

export const SIGNAL_TONE: Record<Signal, { label: string; tone: string; pillBg: string }> = {
  '강한 관심': {
    label: '강한 관심',
    tone: 'text-brand-purple',
    pillBg: 'bg-brand-purple/15 text-brand-purple border border-brand-purple/30',
  },
  '관심': {
    label: '관심',
    tone: 'text-brand-purple',
    pillBg: 'bg-brand-purple/10 text-brand-purple border border-brand-purple/20',
  },
  '관망': {
    label: '관망',
    tone: 'text-txt-secondary',
    pillBg: 'bg-bg-tertiary text-txt-secondary border border-border',
  },
  '주의': {
    label: '주의',
    tone: 'text-status-warning',
    pillBg: 'bg-status-warning/15 text-status-warning border border-status-warning/30',
  },
  '위험': {
    label: '위험',
    tone: 'text-status-error',
    pillBg: 'bg-status-error/15 text-status-error border border-status-error/30',
  },
};

export function formatKoreanDate(iso: string): string {
  const d = new Date(iso);
  const day = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${iso} (${day})`;
}
