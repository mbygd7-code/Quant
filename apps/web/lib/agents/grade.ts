/**
 * Score → SignalGrade mapping shared by client and server code.
 *
 * Per system-weight-settings.md:
 *
 *   weighted_score   →   signal_grade
 *   ──────────────────────────────────
 *   ≥ +1.00          →   STRONG_BUY     (강한 관심)
 *   ≥ +0.30          →   BUY            (관심)
 *   ≥ -0.30          →   HOLD           (관망)
 *   ≥ -1.00          →   CAUTION        (주의)
 *   <  -1.00         →   RISK           (위험)
 *
 * Taleb's auto-constraint (M4) downgrades by one step when severity
 * is 4 and forces HOLD-or-worse when severity is 5; that lives in the
 * Soros character itself, not here.
 */
import { type SignalGrade } from '@/lib/agents/types';

export interface GradeBand {
  grade: SignalGrade;
  /** Inclusive lower bound on weighted_score. */
  scoreMin: number;
  /** UI label (Korean). */
  label: string;
  /** UI accent — maps to existing brand tokens. */
  tone: 'success' | 'positive' | 'neutral' | 'warning' | 'danger';
}

export const GRADE_BANDS: readonly GradeBand[] = [
  { grade: 'STRONG_BUY', scoreMin: 1.0, label: '강한 관심', tone: 'success' },
  { grade: 'BUY', scoreMin: 0.3, label: '관심', tone: 'positive' },
  { grade: 'HOLD', scoreMin: -0.3, label: '관망', tone: 'neutral' },
  { grade: 'CAUTION', scoreMin: -1.0, label: '주의', tone: 'warning' },
  { grade: 'RISK', scoreMin: -Infinity, label: '위험', tone: 'danger' },
];

const _bandByGrade = new Map<SignalGrade, GradeBand>(
  GRADE_BANDS.map((b) => [b.grade, b]),
);

/**
 * Map a weighted score in [-2, +2] to a SignalGrade. Out-of-range
 * values are clipped (defensive — the Pydantic / zod schemas guard
 * the input but a future tweak might pass an unclipped sum).
 */
export function scoreToSignalGrade(score: number): SignalGrade {
  if (Number.isNaN(score)) return 'HOLD';
  for (const band of GRADE_BANDS) {
    if (score >= band.scoreMin) return band.grade;
  }
  return 'RISK';
}

/** UI helpers: get the band metadata for a known grade. */
export function gradeBand(grade: SignalGrade): GradeBand {
  return _bandByGrade.get(grade) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
}

/**
 * Apply Taleb's auto-constraint to a baseline grade.
 *
 *   severity 4 → downgrade by one step
 *   severity 5 → force HOLD-or-worse and (implicitly) zero size
 *
 * This helper is shared so the cron path (Python) and live UI (TS)
 * cannot drift on the rule. The Python mirror lives in
 * `agents/grading.py`.
 */
export function applyTalebConstraint(
  baseline: SignalGrade,
  severity: number | null | undefined,
): { grade: SignalGrade; overridden: boolean } {
  if (severity == null) return { grade: baseline, overridden: false };
  if (severity >= 5) {
    if (baseline === 'STRONG_BUY' || baseline === 'BUY') {
      return { grade: 'HOLD', overridden: true };
    }
    return { grade: baseline, overridden: false };
  }
  if (severity === 4) {
    const order: SignalGrade[] = [
      'STRONG_BUY',
      'BUY',
      'HOLD',
      'CAUTION',
      'RISK',
    ];
    const idx = order.indexOf(baseline);
    if (idx < 0 || idx === order.length - 1) {
      return { grade: baseline, overridden: false };
    }
    return { grade: order[idx + 1], overridden: true };
  }
  return { grade: baseline, overridden: false };
}
