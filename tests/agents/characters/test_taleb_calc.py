"""Pure-function tests for Taleb's risk calculator.

Severity table + asymmetry buckets are pinned exhaustively; the LLM
narrative is exercised once with a stub, mirroring the Graham/Dow
pattern.
"""
from __future__ import annotations

from datetime import UTC, datetime
from datetime import date as Date
from decimal import Decimal
from typing import Any

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters._data import KrQuoteRow
from agents.characters.taleb import (
    EARNINGS_PROXIMITY_DAYS,
    TalebInputs,
    annualised_volatility,
    asymmetry_components,
    combine_risk_score,
    days_to_estimated_earnings,
    max_drawdown_from_peak,
    severity_for,
)


def _quote(close: int, days_back: int, ticker: str = "005930") -> KrQuoteRow:
    return KrQuoteRow(
        date=Date(2026, 5, 9),
        ticker=ticker,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=1_000_000,
        trading_value=close * 1_000_000,
        foreign_net_buy=0,
        change_rate=0.0,
    )


def _flat_series(close: int, n: int) -> list[KrQuoteRow]:
    return [_quote(close, i) for i in range(n)]


def _drawdown_series(peak: int, trough: int, n: int = 250) -> list[KrQuoteRow]:
    """Newest-first list whose oldest half is at ``peak`` and newest
    half drops linearly to ``trough``. Produces a clear max-drawdown."""
    half = n // 2
    out: list[KrQuoteRow] = []
    # newest at index 0 → trough today, peak in the past.
    for i in range(half):
        out.append(_quote(trough + (peak - trough) * i // (half - 1), i))
    for i in range(half, n):
        out.append(_quote(peak, i))
    return out


# ─── annualised_volatility ──────────────────────────────────────────


def test_volatility_zero_for_flat_series() -> None:
    quotes = _flat_series(60_000, 100)
    assert annualised_volatility(quotes) == Decimal("0")


def test_volatility_positive_for_oscillating_series() -> None:
    # alternating ±5% returns → noticeable σ
    quotes: list[KrQuoteRow] = []
    close = 60_000
    for i in range(100):
        quotes.append(_quote(close, i))
        close = int(close * (1.05 if i % 2 == 0 else 1 / 1.05))
    vol = annualised_volatility(quotes)
    assert vol > Decimal("0.10")


# ─── max_drawdown_from_peak ─────────────────────────────────────────


def test_max_drawdown_zero_when_flat() -> None:
    assert max_drawdown_from_peak(_flat_series(60_000, 50)) == Decimal("0")


def test_max_drawdown_detects_peak_to_trough() -> None:
    # Series has peak 100_000 in the past, trough 60_000 today → 40% dd
    quotes = _drawdown_series(peak=100_000, trough=60_000, n=200)
    dd = max_drawdown_from_peak(quotes)
    assert Decimal("0.39") < dd < Decimal("0.41")


# ─── asymmetry_components ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("vol", "max_dd", "expected_score"),
    [
        # ratio = vol / max_dd (max_dd>0 path).
        ("0.30", "0.05", "1.0"),     # ratio 6.0 — strong asymmetry
        ("0.30", "0.15", "0.5"),     # ratio 2.0 — okay
        ("0.30", "0.30", "0"),        # ratio 1.0 — neutral
        ("0.10", "0.40", "-1.0"),    # ratio 0.25 — bad asymmetry
        ("0.10", "0.15", "-0.5"),    # ratio 0.667 — mediocre
        ("0.20", "0", "0"),           # no drawdown → fallback ratio 1.0
        ("0", "0", "0"),               # no data
    ],
)
def test_asymmetry_score_buckets(
    vol: str, max_dd: str, expected_score: str
) -> None:
    _, _, _, score = asymmetry_components(Decimal(vol), Decimal(max_dd))
    assert score == Decimal(expected_score)


# ─── severity_for ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("max_dd", "vol", "earnings_imminent", "expected_severity"),
    [
        ("0.45", "0.45", False, 5),    # blackswan: dd≥40, vol≥40
        ("0.30", "0.35", False, 4),    # severe: dd≥25, vol≥30
        ("0.20", "0.10", False, 3),    # moderate: dd≥15
        ("0.10", "0.10", False, 2),    # minor: dd≥8
        ("0.05", "0.10", False, 1),    # quiet
        # Earnings booster bumps once, capped at 5.
        ("0.10", "0.10", True, 3),     # 2 → 3
        ("0.45", "0.45", True, 5),     # already 5 — no overflow
    ],
)
def test_severity_table(
    max_dd: str,
    vol: str,
    earnings_imminent: bool,
    expected_severity: int,
) -> None:
    sev, bumped = severity_for(
        max_dd=Decimal(max_dd),
        vol=Decimal(vol),
        earnings_imminent=earnings_imminent,
    )
    assert sev == expected_severity
    assert bumped is ((earnings_imminent and expected_severity < 5)
                      or (earnings_imminent and expected_severity > 1
                      and Decimal(max_dd) < Decimal("0.40")))


def test_severity_earnings_bumps_only_when_below_5() -> None:
    sev_low, bumped_low = severity_for(
        max_dd=Decimal("0.05"),
        vol=Decimal("0.10"),
        earnings_imminent=True,
    )
    assert sev_low == 2 and bumped_low is True
    sev_high, bumped_high = severity_for(
        max_dd=Decimal("0.45"),
        vol=Decimal("0.45"),
        earnings_imminent=True,
    )
    assert sev_high == 5 and bumped_high is False


# ─── combine_risk_score ─────────────────────────────────────────────


def test_combine_clamps_to_two() -> None:
    out = combine_risk_score(
        Decimal("3.0"), Decimal("1.0"), Decimal("0.5")
    )
    assert out == Decimal("2.00")


def test_combine_clamps_to_negative_two() -> None:
    out = combine_risk_score(
        Decimal("-1.0"), Decimal("-1.5"), Decimal("-0.9")
    )
    assert out == Decimal("-2.00")


def test_combine_simple_sum() -> None:
    out = combine_risk_score(
        Decimal("0.5"), Decimal("0"), Decimal("-0.3")
    )
    assert out == Decimal("0.20")


# ─── days_to_estimated_earnings ─────────────────────────────────────


def test_days_to_earnings_works_without_financials() -> None:
    """Statutory-calendar version: the answer no longer depends on
    kr_financials at all — 5/9 → 분기보고서 deadline 5/15 = 6 days.
    (The old period_end+91d walk said 52 days here, completely missing
    that 5/9 IS filing week.)"""
    today = datetime(2026, 5, 9, tzinfo=UTC)
    assert days_to_estimated_earnings(today, []) == 6


def test_days_to_earnings_statutory_deadlines() -> None:
    """Fixed Dec-FY calendar: 3/31 사업보고서, 5/15 · 11/14 분기,
    8/14 반기 — exact by law, no 91-day drift."""
    assert days_to_estimated_earnings(datetime(2026, 6, 12, tzinfo=UTC), []) == 63   # → 8/14
    assert days_to_estimated_earnings(datetime(2026, 11, 14, tzinfo=UTC), []) == 0   # deadline day
    assert days_to_estimated_earnings(datetime(2026, 12, 20, tzinfo=UTC), []) == 101  # → 다음해 3/31


def test_days_to_earnings_imminent_window() -> None:
    """5/8 → 5/15 deadline = exactly EARNINGS_PROXIMITY_DAYS (7) —
    the imminent boundary."""
    today = datetime(2026, 5, 8, tzinfo=UTC)
    assert days_to_estimated_earnings(today, []) == EARNINGS_PROXIMITY_DAYS


# ─── analyze() with stubbed LLM ─────────────────────────────────────


def test_analyze_raises_on_thin_data() -> None:
    from agents.characters.taleb import Taleb

    bundle = TalebInputs(quotes=_flat_series(60_000, 5), financials=[])
    t = Taleb()
    with pytest.raises((InsufficientDataError, Exception)):
        # MIN_QUOTES_REQUIRED is 60 by default; 5 should fail somewhere.
        # We don't depend on which exception — just that thin data
        # doesn't silently produce garbage.
        t.analyze(
            "005930",
            datetime(2026, 5, 9, tzinfo=UTC),
            inputs=bundle,
        )


def test_analyze_returns_row_with_score_and_severity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agents.characters import taleb as taleb_mod
    from agents.characters.taleb import Taleb
    from agents.llm.client import ClaudeResult

    fake_result = ClaudeResult(
        text='{"narrative":"변동성과 하방 위험이 비대칭적으로 큽니다."}',
        model="claude-test",
        input_tokens=120,
        output_tokens=40,
        cost_estimate_usd=0.001,
    )
    fake_parsed = taleb_mod.TalebLLMResponse(
        narrative="변동성과 하방 위험이 비대칭적으로 큽니다."
    )
    monkeypatch.setattr(
        taleb_mod, "call_claude", lambda **kwargs: (fake_result, fake_parsed)
    )

    quotes = _drawdown_series(peak=100_000, trough=60_000, n=200)
    bundle = TalebInputs(quotes=quotes, financials=[])
    t = Taleb()
    out = t.analyze(
        "005930",
        datetime(2026, 5, 9, tzinfo=UTC),
        inputs=bundle,
    )
    assert out.agent_name == "taleb"
    assert out.severity is not None
    assert 1 <= out.severity <= 5
    assert -2 <= float(out.score) <= 2
    assert "위험" in out.narrative
    payload = out.raw_payload
    assert "annualised_vol" in payload
    assert "asymmetry_ratio" in payload
    assert payload["data_window_days"] == 200


def test_analyze_uses_inputs_argument(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When ``inputs=`` is passed, fetch() must not be called."""
    from agents.characters import taleb as taleb_mod
    from agents.characters.taleb import Taleb
    from agents.llm.client import ClaudeResult

    monkeypatch.setattr(
        taleb_mod,
        "call_claude",
        lambda **kwargs: (
            ClaudeResult(
                text="x",
                model="m",
                input_tokens=1,
                output_tokens=1,
                cost_estimate_usd=0.0,
            ),
            taleb_mod.TalebLLMResponse(narrative="평가 정상 처리되었습니다"),
        ),
    )

    def boom(self: Any, ticker: str) -> TalebInputs:
        raise AssertionError("fetch should not be called when inputs= passed")

    monkeypatch.setattr(Taleb, "fetch", boom)

    bundle = TalebInputs(
        quotes=_flat_series(60_000, 80), financials=[]
    )
    t = Taleb()
    # 6/9: next statutory deadline 8/14 (66d away) → no earnings bump;
    # flat series → severity 1. (5/9 would now correctly bump to 2 —
    # it sits inside the 5/15 분기보고서 filing week.)
    out = t.analyze(
        "005930", datetime(2026, 6, 9, tzinfo=UTC), inputs=bundle
    )
    assert out.severity == 1  # flat series → quiet
