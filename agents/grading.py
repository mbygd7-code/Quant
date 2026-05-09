"""Score → SignalGrade mapping + Taleb auto-constraint.

Mirror of `apps/web/lib/agents/grade.ts`. Both halves of the agent
system must use the *same* thresholds or the Python cron will produce
a grade the TS UI then re-derives differently.

Bands (system-weight-settings.md):

    weighted_score   →   signal_grade
    ──────────────────────────────────
    ≥ +1.00          →   STRONG_BUY     (강한 관심)
    ≥ +0.30          →   BUY            (관심)
    ≥ -0.30          →   HOLD           (관망)
    ≥ -1.00          →   CAUTION        (주의)
    <  -1.00         →   RISK           (위험)
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal

from agents.db.models import SignalGrade


@dataclass(frozen=True)
class GradeBand:
    grade: SignalGrade
    score_min: float  #: inclusive lower bound
    label: str        #: Korean UI label
    tone: str         #: brand-token tone hint


#: Ordered from highest (most bullish) to lowest. score_to_signal_grade
#: walks this top-down so the first band whose lower bound is met wins.
GRADE_BANDS: tuple[GradeBand, ...] = (
    GradeBand("STRONG_BUY", 1.00, "강한 관심", "success"),
    GradeBand("BUY", 0.30, "관심", "positive"),
    GradeBand("HOLD", -0.30, "관망", "neutral"),
    GradeBand("CAUTION", -1.00, "주의", "warning"),
    GradeBand("RISK", -math.inf, "위험", "danger"),
)

_BAND_BY_GRADE: dict[SignalGrade, GradeBand] = {b.grade: b for b in GRADE_BANDS}


def score_to_signal_grade(score: float | Decimal | None) -> SignalGrade:
    """Map a weighted score in [-2.00, +2.00] to a 5-grade band.

    NaN / None defensively maps to ``HOLD``. Out-of-range values are
    clipped — the upstream Pydantic models guard the bounds, but a
    future tweak might pass an unclipped sum here, and we'd rather
    return a grade than crash the cron.
    """
    if score is None:
        return "HOLD"
    s = float(score)
    if math.isnan(s):
        return "HOLD"
    for band in GRADE_BANDS:
        if s >= band.score_min:
            return band.grade
    return "RISK"


def grade_band(grade: SignalGrade) -> GradeBand:
    return _BAND_BY_GRADE[grade]


def apply_taleb_constraint(
    baseline: SignalGrade, severity: int | None
) -> tuple[SignalGrade, bool]:
    """Returns ``(final_grade, overridden)``.

    Rules (system-weight-settings.md §Taleb auto-constraint):
        severity 5 → STRONG_BUY/BUY both forced down to HOLD
        severity 4 → grade downgraded one step
        severity ≤ 3 or None → unchanged
    """
    if severity is None:
        return baseline, False
    if severity >= 5:
        if baseline in ("STRONG_BUY", "BUY"):
            return "HOLD", True
        return baseline, False
    if severity == 4:
        order: tuple[SignalGrade, ...] = (
            "STRONG_BUY",
            "BUY",
            "HOLD",
            "CAUTION",
            "RISK",
        )
        try:
            idx = order.index(baseline)
        except ValueError:
            return baseline, False
        if idx >= len(order) - 1:
            return baseline, False
        return order[idx + 1], True
    return baseline, False
