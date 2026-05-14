"""Tests for Turing's technical-indicator math.

We pin each component (RSI, MACD, Bollinger %b) against hand-computed
expected values + verify the score-mapper bands. The narrative path is
LLM-only and exercised end-to-end elsewhere; here we keep IO-free.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from agents.characters.turing import (
    BB_MAX,
    MACD_MAX,
    RSI_MAX,
    bb_to_score,
    bollinger_percent_b,
    combine_score,
    macd,
    macd_to_score,
    rsi_14,
    rsi_to_score,
)


# ─── RSI ────────────────────────────────────────────────────────────


def test_rsi_returns_none_when_too_short() -> None:
    assert rsi_14([100.0] * 14) is None  # need 15+


def test_rsi_all_gains_returns_100() -> None:
    closes = [float(c) for c in range(120, 100, -1)]  # newest 120 → oldest 101 (increasing)
    rsi = rsi_14(closes)
    assert rsi is not None
    assert rsi > 99


def test_rsi_all_losses_returns_low() -> None:
    closes = [float(c) for c in range(100, 120)]  # newest 100, falling
    rsi = rsi_14(closes)
    assert rsi is not None
    assert rsi < 1


def test_rsi_balanced_around_50() -> None:
    # Sawtooth — gains roughly balance losses.
    closes = [100.0 + (i % 2) for i in range(30)]
    rsi = rsi_14(closes)
    assert rsi is not None
    assert 40 < rsi < 60


# ─── RSI → score ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("rsi", "expected"),
    [
        (None, Decimal("0")),
        (15.0, RSI_MAX),
        (30.0, RSI_MAX),
        (50.0, Decimal("0")),
        (70.0, -RSI_MAX),
        (85.0, -RSI_MAX),
    ],
)
def test_rsi_score_bands(rsi: float | None, expected: Decimal) -> None:
    assert rsi_to_score(rsi) == expected


def test_rsi_score_is_linear_in_middle() -> None:
    s = rsi_to_score(40.0)  # 1/4 of the way from 30 → 70
    # Expected: RSI_MAX * (1 - 2 * 0.25) = RSI_MAX * 0.5 = +0.35
    assert s == (RSI_MAX * Decimal("0.5")).quantize(Decimal("0.01"))


# ─── MACD ───────────────────────────────────────────────────────────


def test_macd_returns_none_when_too_short() -> None:
    assert macd([100.0] * 30) is None  # need 35+


def test_macd_accelerating_uptrend_positive_hist() -> None:
    # Quadratic ramp — accelerating uptrend means the fast EMA outpaces
    # the slow one and the signal line, producing a clearly positive
    # histogram. A perfectly linear ramp would produce hist ≈ 0 because
    # both EMAs converge at the same rate.
    closes_newest_first = [float(50 + (50 - i) ** 1.5) for i in range(50)]
    out = macd(closes_newest_first)
    assert out is not None
    hist, _sig, _dir = out
    assert hist > 0


def test_macd_recent_dump_negative_hist() -> None:
    # Steady prices then a sharp recent drop — fast EMA tracks the drop
    # quicker than slow, producing a clearly negative histogram on the
    # last bar.
    closes_newest_first = [70.0, 75.0, 80.0, 85.0, 90.0] + [100.0] * 45
    out = macd(closes_newest_first)
    assert out is not None
    hist, _sig, _dir = out
    assert hist < 0


# ─── MACD → score ───────────────────────────────────────────────────


def test_macd_score_zero_when_none() -> None:
    assert macd_to_score(None, 0) == Decimal("0")


def test_macd_score_positive_on_up_crossover() -> None:
    s = macd_to_score(50.0, +1)
    assert s > 0
    assert s <= MACD_MAX


def test_macd_score_caps_at_macd_max() -> None:
    s = macd_to_score(1000.0, +1)
    assert s == MACD_MAX


def test_macd_score_half_weight_without_crossover() -> None:
    s = macd_to_score(5.0, 0)
    # Sign-only at half-max → -MACD_MAX/2 .. +MACD_MAX/2
    assert abs(s) <= MACD_MAX / Decimal("2")


# ─── Bollinger ──────────────────────────────────────────────────────


def test_bollinger_returns_none_when_too_short() -> None:
    assert bollinger_percent_b([100.0] * 10) is None


def test_bollinger_above_upper_band() -> None:
    base = [100.0] * 19
    spike = [120.0]  # newest, way above 2σ
    pct = bollinger_percent_b(spike + base)
    assert pct is not None
    assert pct > 1


def test_bollinger_below_lower_band() -> None:
    base = [100.0] * 19
    crash = [80.0]
    pct = bollinger_percent_b(crash + base)
    assert pct is not None
    assert pct < 0


def test_bollinger_flat_series_returns_mid() -> None:
    assert bollinger_percent_b([100.0] * 20) == 0.5


# ─── BB → score ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("pb", "expected"),
    [
        (None, Decimal("0")),
        (-0.2, BB_MAX),
        (0.5, Decimal("0")),
        (1.4, -BB_MAX),
    ],
)
def test_bb_score_bands(pb: float | None, expected: Decimal) -> None:
    assert bb_to_score(pb) == expected


# ─── Combined score ─────────────────────────────────────────────────


def test_combine_clips_to_two() -> None:
    s = combine_score(Decimal("1.5"), Decimal("1.5"), Decimal("1.5"))
    assert s == Decimal("2.00")


def test_combine_clips_negative_too() -> None:
    s = combine_score(Decimal("-1.5"), Decimal("-1.5"), Decimal("-1.5"))
    assert s == Decimal("-2.00")


def test_combine_simple_sum() -> None:
    s = combine_score(Decimal("0.30"), Decimal("0.20"), Decimal("-0.10"))
    assert s == Decimal("0.40")
