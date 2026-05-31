"""Tests for confidence_from_voters + apply_confidence_gate.

The two together close the '강한 관심 with 50% 신뢰도' loophole: a
weighted_score of +1.00 driven by a single +2 voter (and 4 neutrals)
now derives a low confidence and gets demoted to BUY.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from agents.characters.soros import confidence_from_voters
from agents.grading import (
    BUY_CONFIDENCE_FLOOR,
    STRONG_BUY_CONFIDENCE_FLOOR,
    apply_confidence_gate,
)

# ─── confidence_from_voters ─────────────────────────────────────────


def test_unanimous_voters_yield_high_confidence() -> None:
    scores = {a: Decimal("1.0") for a in ("graham", "dow", "shiller", "keynes", "taleb")}
    conf = confidence_from_voters(scores, Decimal("1.00"))
    # All agree on direction (5/5) and dispersion 0 → confidence ~1.0
    assert conf >= Decimal("0.95")


def test_single_voter_drives_signal_yields_low_confidence() -> None:
    """The exact case the user surfaced: 1 voter at +2, 4 at 0."""
    scores = {
        "graham":  Decimal("0"),
        "dow":     Decimal("0"),
        "shiller": Decimal("0"),
        "keynes":  Decimal("2.00"),
        "taleb":   Decimal("0"),
    }
    conf = confidence_from_voters(scores, Decimal("0.40"))
    # Only 1/1 non-zero voter agrees with direction (so directional=1.0),
    # but dispersion is high. Formula: 0.5*1.0 + 0.5*(1 - 0.8) = 0.6
    # The previous bug returned 0.50 — the new value should be ≤0.65
    # AND clearly differentiated from the unanimous case above.
    assert conf < Decimal("0.65")


def test_split_voters_yield_mid_confidence() -> None:
    scores = {
        "graham":  Decimal("0.5"),
        "dow":     Decimal("0.5"),
        "shiller": Decimal("0.5"),
        "keynes":  Decimal("-0.5"),
        "taleb":   Decimal("-0.5"),
    }
    conf = confidence_from_voters(scores, Decimal("0.10"))
    # 3/5 agree on positive direction (assuming adjusted is positive).
    # Dispersion ~0.5. Expect somewhere in 0.3..0.7.
    assert Decimal("0.3") <= conf <= Decimal("0.7")


def test_all_abstentions_yield_low_confidence() -> None:
    scores = {a: Decimal("0") for a in ("graham", "dow", "shiller", "keynes", "taleb")}
    conf = confidence_from_voters(scores, Decimal("0"))
    # Zero target sign + zero voter signs → directional=0.5, dispersion=0
    # → confidence = 0.5*0.5 + 0.5*1.0 = 0.75
    # That's actually HIGH — and correct: when everyone agrees on
    # "nothing to see here", the system is confidently neutral.
    assert conf >= Decimal("0.7")


def test_empty_voters_returns_zero() -> None:
    assert confidence_from_voters({}, Decimal("0")) == Decimal("0")


# ─── apply_confidence_gate ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("grade", "conf", "expected_grade", "demoted"),
    [
        # STRONG_BUY survives only with confidence ≥ 0.70
        ("STRONG_BUY", 0.50, "BUY", True),
        ("STRONG_BUY", 0.69, "BUY", True),
        ("STRONG_BUY", 0.70, "STRONG_BUY", False),
        ("STRONG_BUY", 0.90, "STRONG_BUY", False),
        # BUY survives only with confidence ≥ 0.50
        ("BUY", 0.30, "HOLD", True),
        ("BUY", 0.49, "HOLD", True),
        ("BUY", 0.50, "BUY", False),
        # Neutral / negative grades pass through untouched.
        ("HOLD", 0.10, "HOLD", False),
        ("CAUTION", 0.10, "CAUTION", False),
        ("RISK", 0.10, "RISK", False),
    ],
)
def test_gate_demotion_table(
    grade: str, conf: float, expected_grade: str, demoted: bool,
) -> None:
    out, was_demoted = apply_confidence_gate(grade, conf)  # type: ignore[arg-type]
    assert out == expected_grade
    assert was_demoted is demoted


def test_gate_passes_through_when_confidence_none() -> None:
    out, demoted = apply_confidence_gate("STRONG_BUY", None)
    assert out == "STRONG_BUY"
    assert demoted is False


def test_gate_threshold_constants_exposed() -> None:
    # Pin the constants so a refactor that loosens them shows up as a
    # red test rather than a silent UX regression.
    assert STRONG_BUY_CONFIDENCE_FLOOR == 0.70
    assert BUY_CONFIDENCE_FLOOR == 0.50


# ─── End-to-end: user's "강한 관심 + 50%" scenario ──────────────────


def test_samsung_sdi_style_signal_gets_demoted() -> None:
    """Reproduces the bug report:
        1 voter at +2, 4 voters at 0
        → previously: STRONG_BUY + 50% confidence (paradox)
        → now: BUY (demoted), with confidence ≤ 0.65
    """
    scores = {
        "graham":  Decimal("0"),
        "dow":     Decimal("0"),
        "shiller": Decimal("0"),
        "keynes":  Decimal("2.00"),
        "taleb":   Decimal("0"),
    }
    # Simulate Soros' M4 pipeline:
    #   q1 = weighted sum (assuming equal shares 0.2) = +0.4
    #   priced_in dampening → adjusted ~1.0 (matches user's screenshot)
    adjusted = Decimal("1.00")
    conf = confidence_from_voters(scores, adjusted)
    baseline_grade = "STRONG_BUY"  # adjusted >= 1.00 maps to STRONG_BUY
    gated, demoted = apply_confidence_gate(baseline_grade, conf)
    # Confidence is below 0.70 → demote to BUY.
    assert conf < Decimal("0.70")
    assert gated == "BUY"
    assert demoted is True
