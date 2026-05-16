"""Pin the priced_in dampening direction.

User report: the M4 narrative described "priced_in 0.82 반영 후 최종 점수
1.00으로 상향 조정" — that "상향" (upward) wording confused users because
the function actually dampens (halves) the score when priced_in is high.

The math is correct; the LLM narrative just used misleading direction
wording. These tests pin the math so a future refactor can't silently
invert the direction.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from agents.characters.soros import (
    PRICED_IN_DAMPEN_FACTOR,
    PRICED_IN_DAMPEN_THRESHOLD,
    apply_priced_in,
)


# ─── Below the threshold → pass through unchanged ───────────────────


@pytest.mark.parametrize(
    "priced_in",
    ["0.00", "0.30", "0.50", "0.69", "0.70"],  # 0.70 = boundary, NOT >
)
def test_below_threshold_passes_through(priced_in: str) -> None:
    out = apply_priced_in(Decimal("1.20"), Decimal(priced_in))
    assert out == Decimal("1.20")


# ─── Above the threshold → dampen (halve) ───────────────────────────


@pytest.mark.parametrize(
    ("score_in", "priced_in", "expected"),
    [
        # Strong positive halved
        ("2.00", "0.71", "1.00"),
        ("2.00", "0.90", "1.00"),
        ("1.50", "0.80", "0.75"),
        # Negative scores also halve (direction preserved)
        ("-2.00", "0.85", "-1.00"),
        ("-1.20", "0.82", "-0.60"),
        # Near-zero stays near-zero
        ("0.10", "0.82", "0.05"),
    ],
)
def test_above_threshold_dampens(
    score_in: str, priced_in: str, expected: str,
) -> None:
    out = apply_priced_in(Decimal(score_in), Decimal(priced_in))
    assert out == Decimal(expected)


# ─── Direction is *down* in magnitude, never up ─────────────────────


@pytest.mark.parametrize("priced_in", ["0.71", "0.80", "0.90", "1.00"])
def test_dampening_never_amplifies_magnitude(priced_in: str) -> None:
    """The bug everyone worries about: priced_in increasing |score|.
    This test fails loudly if a future refactor inverts the factor."""
    for s in ("-2.0", "-0.5", "0.5", "2.0"):
        original = Decimal(s)
        out = apply_priced_in(original, Decimal(priced_in))
        assert abs(out) <= abs(original), (
            f"priced_in must dampen, never amplify: "
            f"|{out}| > |{original}| at priced_in={priced_in}"
        )


def test_dampening_preserves_sign() -> None:
    for s in ("-2.0", "-0.01", "0.01", "2.0"):
        original = Decimal(s)
        out = apply_priced_in(original, Decimal("0.85"))
        if original > 0:
            assert out >= 0
        if original < 0:
            assert out <= 0


# ─── Constants are reasonable ───────────────────────────────────────


def test_threshold_constant() -> None:
    assert PRICED_IN_DAMPEN_THRESHOLD == Decimal("0.70")


def test_factor_is_a_dampener() -> None:
    """factor must be in (0, 1] — anything ≥1 would amplify or pass
    through, anything ≤0 would invert the sign."""
    assert Decimal("0") < PRICED_IN_DAMPEN_FACTOR <= Decimal("1")
    # Specifically 0.5 per character-soros.md §3 Q2.
    assert PRICED_IN_DAMPEN_FACTOR == Decimal("0.5")


# ─── Edge: q=2 + priced_in=0.82 → adjusted=1.00 (matches user report) ─


def test_users_screenshot_scenario() -> None:
    """Reproduce the screenshot: q1=2.0, priced_in=0.82 → adjusted=1.00.
    The narrative LLM described this as '상향 조정' which is misleading —
    1.00 < 2.00 in magnitude, so it's actually a *downgrade*. This test
    documents what the math does."""
    adjusted = apply_priced_in(Decimal("2.00"), Decimal("0.82"))
    assert adjusted == Decimal("1.00")
    # Crucially: the result is SMALLER than the input.
    assert adjusted < Decimal("2.00")
