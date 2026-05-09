"""Score → grade mapping + Taleb auto-constraint tests.

Lock the rules so the TS twin can't drift silently — every band
boundary and Taleb override case is pinned here.
"""
from __future__ import annotations

import pytest

from agents.grading import (
    apply_taleb_constraint,
    grade_band,
    score_to_signal_grade,
)


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        (2.00, "STRONG_BUY"),
        (1.00, "STRONG_BUY"),
        (0.999, "BUY"),
        (0.30, "BUY"),
        (0.299, "HOLD"),
        (0.00, "HOLD"),
        (-0.299, "HOLD"),
        (-0.30, "HOLD"),
        (-0.301, "CAUTION"),
        (-1.00, "CAUTION"),
        (-1.001, "RISK"),
        (-2.00, "RISK"),
    ],
)
def test_band_boundaries(score: float, expected: str) -> None:
    assert score_to_signal_grade(score) == expected


def test_none_and_nan_default_to_hold() -> None:
    assert score_to_signal_grade(None) == "HOLD"
    assert score_to_signal_grade(float("nan")) == "HOLD"


def test_band_metadata_label_korean() -> None:
    assert grade_band("STRONG_BUY").label == "강한 관심"
    assert grade_band("RISK").label == "위험"


def test_taleb_severity_4_downgrades_one_step() -> None:
    assert apply_taleb_constraint("STRONG_BUY", 4) == ("BUY", True)
    assert apply_taleb_constraint("BUY", 4) == ("HOLD", True)
    assert apply_taleb_constraint("HOLD", 4) == ("CAUTION", True)
    assert apply_taleb_constraint("CAUTION", 4) == ("RISK", True)


def test_taleb_severity_5_forces_hold_for_bullish() -> None:
    assert apply_taleb_constraint("STRONG_BUY", 5) == ("HOLD", True)
    assert apply_taleb_constraint("BUY", 5) == ("HOLD", True)
    # Neutral or bearish stays as-is — already cautious.
    assert apply_taleb_constraint("HOLD", 5) == ("HOLD", False)
    assert apply_taleb_constraint("RISK", 5) == ("RISK", False)


def test_taleb_severity_low_unchanged() -> None:
    for s in (None, 1, 2, 3):
        assert apply_taleb_constraint("STRONG_BUY", s) == ("STRONG_BUY", False)
        assert apply_taleb_constraint("HOLD", s) == ("HOLD", False)


def test_taleb_severity_4_at_floor_does_not_underflow() -> None:
    """RISK is already the worst; sev-4 has nothing lower to go to."""
    assert apply_taleb_constraint("RISK", 4) == ("RISK", False)
