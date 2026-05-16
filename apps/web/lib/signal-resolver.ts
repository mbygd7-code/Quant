/**
 * Unified signal resolver — bridges the legacy `ai_scores` (cognition/
 * scorer.py 7-factor) and the new `final_signals` (M4 캐릭터 voter)
 * worlds during the cutover period.
 *
 * Preference order:
 *   1. `final_signals` row for the ticker (latest cycle_at) — uses
 *      Soros-synthesised voter consensus
 *   2. `ai_scores` row for the ticker (latest date) — fallback for
 *      tickers the character cycle hasn't analysed yet
 *
 * Both forms are projected to a single `ResolvedSignal` shape so UI
 * components don't have to branch.
 */

import type { Signal } from '@/lib/types';

export type SignalGrade =
  | 'STRONG_BUY'
  | 'BUY'
  | 'HOLD'
  | 'CAUTION'
  | 'RISK';

export interface ResolvedSignal {
  ticker: string;
  /** Korean label — "강한 관심" / "관심" / "관망" / "주의" / "위험". */
  label: Signal;
  /** 5-grade enum form — preserved for sorting / filtering. */
  grade: SignalGrade;
  /** 0..1 user-facing score (final_signals.confidence OR ai_scores.final_score). */
  score: number | null;
  /** Source identifier for badges / debugging. */
  source: 'character' | 'legacy';
  /** Only present on character path — null on legacy. */
  taleb_severity?: number | null;
  taleb_override?: boolean;
}

/** Map a 5-grade enum to the Korean label used across the app. */
export function gradeToLabel(grade: SignalGrade): Signal {
  switch (grade) {
    case 'STRONG_BUY': return '강한 관심';
    case 'BUY':        return '관심';
    case 'HOLD':       return '관망';
    case 'CAUTION':    return '주의';
    case 'RISK':       return '위험';
  }
}

/** Reverse map — used by /watchlist filter dropdown etc. */
export function labelToGrade(label: Signal): SignalGrade {
  switch (label) {
    case '강한 관심': return 'STRONG_BUY';
    case '관심':      return 'BUY';
    case '관망':      return 'HOLD';
    case '주의':      return 'CAUTION';
    case '위험':      return 'RISK';
  }
}

/** Map weighted_score (-2..+2) to a 5-grade. Mirrors agents/grading.py
 *  so the TS UI never disagrees with the Python cycle worker. */
export function weightedScoreToGrade(score: number): SignalGrade {
  if (score >= 1.0)   return 'STRONG_BUY';
  if (score >= 0.3)   return 'BUY';
  if (score >= -0.3)  return 'HOLD';
  if (score >= -1.0)  return 'CAUTION';
  return 'RISK';
}

/** Map final_score (0..1) to a grade — legacy ai_scores uses thresholds
 *  from migration 8's signal_threshold_strong/etc. We approximate them
 *  with the standard breakpoints since the UI only needs coarse buckets. */
export function legacyFinalScoreToGrade(score: number): SignalGrade {
  if (score >= 0.80) return 'STRONG_BUY';
  if (score >= 0.65) return 'BUY';
  if (score >= 0.50) return 'HOLD';
  if (score >= 0.35) return 'CAUTION';
  return 'RISK';
}
