"""Pure-function tests for Dow's trend calculator.

Synthetic 200-day price series let us pin every alignment outcome
without touching Supabase. The LLM path is exercised by analyze()
with a mocked call_claude in test_dow_analyze.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import date as Date
from decimal import Decimal

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters._data import KrQuoteRow
from agents.characters.dow import (
    ALIGNMENT_LABELS,
    MIN_QUOTES_REQUIRED,
    Dow,
    DowInputs,
    alignment_to_score,
    trend_axes,
    volume_confirms,
)


def _quote(d: Date, close: int, volume: int = 1_000_000) -> KrQuoteRow:
    return KrQuoteRow(
        date=d,
        ticker="005930",
        open=close - 100,
        high=close + 200,
        low=close - 200,
        close=close,
        volume=volume,
        trading_value=close * volume,
        foreign_net_buy=0,
        change_rate=0.0,
    )


def _series(closes: list[int], volumes: list[int] | None = None) -> list[KrQuoteRow]:
    """Build a newest-first quote series. ``closes[0]`` is today.

    Volumes default to a flat 1M for every day.
    """
    if volumes is None:
        volumes = [1_000_000] * len(closes)
    today = Date(2026, 5, 9)
    out: list[KrQuoteRow] = []
    for i, (c, v) in enumerate(zip(closes, volumes)):
        out.append(_quote(today - timedelta(days=i), c, v))
    return out


def _linear(start: int, end: int, n: int) -> list[int]:
    """Equally-spaced integer series of length n from ``start`` to ``end``.
    Returned newest-first (so element 0 = end)."""
    if n == 1:
        return [end]
    step = (end - start) / (n - 1)
    asc = [round(start + step * i) for i in range(n)]
    return list(reversed(asc))


# ─── trend_axes ──────────────────────────────────────────────────────


def test_strong_uptrend_all_axes_positive() -> None:
    """Linear rise from 50_000 to 70_000 over 250 days.

    MA5 (newest) > MA20 > MA60 > MA200, close above MA200 → +3.
    """
    series = _series(_linear(50_000, 70_000, 250))
    axes = trend_axes(series)
    assert axes.primary == 1
    assert axes.secondary == 1
    assert axes.minor == 1
    assert axes.alignment == 3


def test_strong_downtrend_all_axes_negative() -> None:
    series = _series(_linear(70_000, 50_000, 250))
    axes = trend_axes(series)
    assert axes.alignment == -3


def test_sideways_returns_zero() -> None:
    """A perfectly flat 200-day series should produce alignment 0.

    Equal MAs at every level → primary/secondary/minor all 0.
    """
    series = _series([60_000] * 250)
    axes = trend_axes(series)
    assert axes.alignment == 0


def test_recent_pullback_against_uptrend() -> None:
    """Long uptrend but the last 5 days dip below MA20.

    Expected: primary +1 (close still > MA200), secondary +1 (MA20 >
    MA60 still), minor -1 (MA5 < MA20 from the dip) → +1.
    """
    long_term = _linear(50_000, 68_000, 245)  # newest-first
    # Replace the newest 5 days with a dip
    long_term[:5] = [62_000, 62_500, 63_000, 63_500, 64_000]
    series = _series(long_term)
    axes = trend_axes(series)
    assert axes.primary == 1
    assert axes.minor == -1
    assert axes.alignment in (0, 1)  # depending on MA20 vs MA60 after dip


def test_trend_axes_raises_on_short_window() -> None:
    series = _series(_linear(50_000, 60_000, MIN_QUOTES_REQUIRED - 1))
    with pytest.raises(ValueError, match="trend_axes needs"):
        trend_axes(series)


# ─── volume_confirms ─────────────────────────────────────────────────


def test_volume_confirms_bull_high_recent() -> None:
    """Recent 5-day volume well above the 20-day overlap average → bull confirmed.

    The 20-day window includes the recent 5, so the ratio is recent_5 /
    avg(all 20) — diluted but still captures momentum. Here:
      avg20 = (5 × 2M + 15 × 1M) / 20 = 1.25M
      recent5 = 2M
      ratio = 2.00 / 1.25 = 1.60
    1.60 ≥ VOL_CONFIRM_BULL (1.10) → confirmed.
    """
    closes = [60_000] * 25
    vols = [2_000_000] * 5 + [1_000_000] * 20
    series = _series(closes, vols)
    confirmed, ratio = volume_confirms(series, alignment=2)
    assert confirmed is True
    assert ratio == Decimal("1.60")


def test_volume_does_not_confirm_bull_when_quiet() -> None:
    """Recent 5-day volume well below the 20-day overlap average → bull NOT confirmed.

      avg20 = (5 × 0.5M + 15 × 1M) / 20 = 0.875M
      recent5 = 0.5M
      ratio = 0.5 / 0.875 ≈ 0.57
    0.57 < VOL_CONFIRM_BULL (1.10) → not confirmed.
    """
    vols = [500_000] * 5 + [1_000_000] * 20
    series = _series([60_000] * 25, vols)
    confirmed, ratio = volume_confirms(series, alignment=2)
    assert confirmed is False
    assert ratio == Decimal("0.57")


def test_volume_sideways_always_confirmed() -> None:
    """Alignment 0 → no direction to confirm; we say 'confirmed'."""
    series = _series([60_000] * 25, [1_000_000] * 25)
    confirmed, _ = volume_confirms(series, alignment=0)
    assert confirmed is True


def test_volume_bear_confirms_at_unity() -> None:
    """Bear alignment: any ratio ≥ 1.00 confirms."""
    vols = [1_100_000] * 5 + [1_000_000] * 20
    series = _series([60_000] * 25, vols)
    confirmed, _ = volume_confirms(series, alignment=-2)
    assert confirmed is True


def test_volume_short_window_returns_false() -> None:
    series = _series([60_000] * 10, [1_000_000] * 10)
    confirmed, ratio = volume_confirms(series, alignment=1)
    assert confirmed is False
    assert ratio == Decimal(0)


# ─── alignment_to_score ──────────────────────────────────────────────


@pytest.mark.parametrize(
    ("alignment", "confirmed", "expected"),
    [
        (3, True, "1.50"),     # strong bull, vol confirmed
        (3, False, "0.90"),    # strong bull but vol weak → 1.5 × 0.6
        (2, True, "1.00"),
        (1, True, "0.50"),
        (1, False, "0.30"),
        (0, True, "0"),
        (0, False, "0"),       # sideways uses dampening but base=0
        (-1, True, "-0.50"),
        (-2, False, "-0.60"),  # -1.0 × 0.6
        (-3, True, "-1.50"),
        (-3, False, "-0.90"),
    ],
)
def test_alignment_to_score_matrix(
    alignment: int, confirmed: bool, expected: str
) -> None:
    out = alignment_to_score(alignment, confirmed)
    assert out == Decimal(expected)


def test_alignment_to_score_clamped_to_two() -> None:
    """Even at the maximum alignment + dampening, score sits inside
    [-2.00, +2.00] — proven by construction (1.5 < 2.0) but the
    clamp guards a future change to the multiplier."""
    out = alignment_to_score(3, True)
    assert -Decimal(2) <= out <= Decimal(2)


def test_alignment_labels_complete() -> None:
    for sum_value in range(-3, 4):
        assert sum_value in ALIGNMENT_LABELS


# ─── analyze() with mocked LLM ──────────────────────────────────────


def test_analyze_raises_insufficient_data_below_window() -> None:
    short = _series(_linear(50_000, 60_000, 100))
    inputs = DowInputs(quotes=short)
    d = Dow()
    with pytest.raises(InsufficientDataError):
        d.analyze(
            "005930",
            datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
            inputs=inputs,
        )


def test_analyze_returns_row_with_score(monkeypatch: pytest.MonkeyPatch) -> None:
    from agents.characters import dow as dow_mod
    from agents.llm.client import ClaudeResult

    fake_result = ClaudeResult(
        text='{"narrative":"3축 모두 정렬, 거래량 확증."}',
        model="claude-test",
        input_tokens=200,
        output_tokens=30,
        cost_estimate_usd=0.001,
    )
    fake_parsed = dow_mod.DowLLMResponse(narrative="3축 모두 정렬, 거래량 확증.")
    monkeypatch.setattr(
        dow_mod, "call_claude", lambda **kwargs: (fake_result, fake_parsed)
    )

    series = _series(_linear(50_000, 70_000, 250))
    out = Dow().analyze(
        "005930",
        datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        inputs=DowInputs(quotes=series),
    )

    assert out.agent_name == "dow"
    assert out.ticker == "005930"
    assert -Decimal(2) <= out.score <= Decimal(2)
    payload = out.raw_payload
    assert payload["alignment_label"] == ALIGNMENT_LABELS[3]
    assert payload["primary_trend"] == 1
    assert payload["data_window_days"] >= MIN_QUOTES_REQUIRED


def test_analyze_volume_dampening_lowers_score(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Strong uptrend but weak volume — score should be 0.9 (1.5 × 0.6)."""
    from agents.characters import dow as dow_mod
    from agents.llm.client import ClaudeResult

    fake_result = ClaudeResult(
        text='{"narrative":"추세 상승 중이지만 거래량 약세."}',
        model="claude-test",
        input_tokens=180,
        output_tokens=25,
        cost_estimate_usd=0.001,
    )
    fake_parsed = dow_mod.DowLLMResponse(
        narrative="추세 상승 중이지만 거래량 약세."
    )
    monkeypatch.setattr(
        dow_mod, "call_claude", lambda **kwargs: (fake_result, fake_parsed)
    )

    closes = _linear(50_000, 70_000, 250)
    # Last 5 days at 50% of normal volume.
    vols = [500_000] * 5 + [1_000_000] * 245
    series = _series(closes, vols)

    out = Dow().analyze(
        "005930",
        datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        inputs=DowInputs(quotes=series),
    )

    assert out.score == Decimal("0.90")
    assert out.raw_payload["volume_confirmed"] is False
