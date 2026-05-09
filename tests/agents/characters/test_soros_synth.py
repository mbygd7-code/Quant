"""Tests for Soros' synthesis math + change-event detection.

Pure-function math is pinned exhaustively. The full ``synthesize``
flow is exercised once with mocked Graham + Dow rows, mocked
``call_claude``, and a stub repository.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import date as Date
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock
from uuid import UUID, uuid4

import pytest

from agents.characters._data import KrQuoteRow
from agents.characters.soros import (
    PRICED_IN_DAMPEN_FACTOR,
    PRICED_IN_DAMPEN_THRESHOLD,
    Soros,
    SorosInputs,
    apply_priced_in,
    confidence_from_score,
    detect_grade_change,
    m2_voter_shares,
    weighted_q1_score,
)
from agents.db.models import (
    AgentOutput,
    FinalSignal,
)
from agents.weights.constants import DEFAULT_WEIGHTS

# ─── m2_voter_shares ─────────────────────────────────────────────────


def test_voter_shares_default_split() -> None:
    """Default user weights have graham=0.18, dow=0.18 → 50/50."""
    out = m2_voter_shares(
        {
            "graham": Decimal("0.18"),
            "dow": Decimal("0.18"),
            "simons": Decimal("0.20"),
            "shiller": Decimal("0.13"),
            "keynes": Decimal("0.18"),
            "taleb": Decimal("0.13"),
        }
    )
    assert out["graham"] == Decimal("0.5")
    assert out["dow"] == Decimal("0.5")


def test_voter_shares_skewed() -> None:
    """User who values graham 4× dow → 80/20."""
    out = m2_voter_shares(
        {"graham": Decimal("0.40"), "dow": Decimal("0.10")}
    )
    assert out["graham"] == Decimal("0.8")
    assert out["dow"] == Decimal("0.2")


def test_voter_shares_zero_zero_falls_back_to_5050() -> None:
    out = m2_voter_shares({"graham": Decimal(0), "dow": Decimal(0)})
    assert out == {"graham": Decimal("0.5"), "dow": Decimal("0.5")}


def test_voter_shares_sum_to_one_within_tolerance() -> None:
    out = m2_voter_shares(
        {"graham": Decimal("0.07"), "dow": Decimal("0.13")}
    )
    total = out["graham"] + out["dow"]
    assert abs(total - Decimal(1)) <= Decimal("0.001")


# ─── weighted_q1_score ───────────────────────────────────────────────


def test_q1_basic_weighted_sum() -> None:
    shares = {"graham": Decimal("0.5"), "dow": Decimal("0.5")}
    out = weighted_q1_score(Decimal("1.0"), Decimal("-0.5"), shares)
    assert out == Decimal("0.25")


def test_q1_skewed_weights() -> None:
    shares = {"graham": Decimal("0.8"), "dow": Decimal("0.2")}
    out = weighted_q1_score(Decimal("1.0"), Decimal("-1.0"), shares)
    assert out == Decimal("0.6")


def test_q1_missing_graham_carries_dow() -> None:
    """When Graham couldn't score, Dow's vote stands at its share."""
    shares = {"graham": Decimal("0.5"), "dow": Decimal("0.5")}
    out = weighted_q1_score(None, Decimal("1.5"), shares)
    assert out == Decimal("0.75")  # 0.5 × 1.5


def test_q1_both_missing_gives_zero() -> None:
    shares = {"graham": Decimal("0.5"), "dow": Decimal("0.5")}
    out = weighted_q1_score(None, None, shares)
    assert out == Decimal("0")


# ─── apply_priced_in ─────────────────────────────────────────────────


def test_priced_in_below_threshold_passes_through() -> None:
    out = apply_priced_in(Decimal("1.20"), Decimal("0.50"))
    assert out == Decimal("1.20")


def test_priced_in_at_threshold_does_not_dampen() -> None:
    """Strictly greater than 0.70 dampens; equal = pass-through."""
    out = apply_priced_in(Decimal("1.20"), PRICED_IN_DAMPEN_THRESHOLD)
    assert out == Decimal("1.20")


def test_priced_in_above_threshold_dampens() -> None:
    out = apply_priced_in(Decimal("1.20"), Decimal("0.85"))
    expected = (Decimal("1.20") * PRICED_IN_DAMPEN_FACTOR).quantize(
        Decimal("0.01")
    )
    assert out == expected
    assert out == Decimal("0.60")


def test_priced_in_negative_score_dampened_proportionally() -> None:
    """Bear signal also gets weakened when market 'priced in' the
    bad news already."""
    out = apply_priced_in(Decimal("-1.50"), Decimal("0.90"))
    assert out == Decimal("-0.75")


# ─── confidence_from_score ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("score", "expected"),
    [
        ("0", "0"),
        ("1.00", "0.5"),
        ("-1.00", "0.5"),
        ("2.00", "1"),
        ("-2.00", "1"),
        ("1.30", "0.65"),
    ],
)
def test_confidence_from_score(score: str, expected: str) -> None:
    out = confidence_from_score(Decimal(score))
    assert out == Decimal(expected)


# ─── detect_grade_change ─────────────────────────────────────────────


def _final_signal(grade: str = "BUY") -> FinalSignal:
    """Build a minimal FinalSignal for change-detection tests."""
    return FinalSignal(
        id=uuid4(),
        ticker="005930",
        cycle_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        signal_grade=grade,  # type: ignore[arg-type]
        weights_snapshot={},
        narrative="prev",
        confidence=Decimal("0.5"),
        weighted_score=Decimal("0.5"),
        taleb_override=False,
        created_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
    )


def test_change_detection_first_signal() -> None:
    from_grade, changed = detect_grade_change(None, "BUY")
    assert from_grade is None
    assert changed is True


def test_change_detection_same_grade() -> None:
    prev = _final_signal("HOLD")
    from_grade, changed = detect_grade_change(prev, "HOLD")
    assert from_grade == "HOLD"
    assert changed is False


def test_change_detection_grade_flipped() -> None:
    prev = _final_signal("BUY")
    from_grade, changed = detect_grade_change(prev, "HOLD")
    assert from_grade == "BUY"
    assert changed is True


# ─── full synthesize() flow with mocks ──────────────────────────────


def _agent_output(agent: str, score: str, narrative: str = "ok") -> AgentOutput:
    return AgentOutput(
        id=uuid4(),
        agent_name=agent,  # type: ignore[arg-type]
        ticker="005930",
        cycle_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        score=Decimal(score),
        severity=None,
        narrative=narrative,
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
        created_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
    )


def _quote(close: int = 60_000, vol: int = 1_000_000, days_back: int = 0) -> KrQuoteRow:
    return KrQuoteRow(
        date=Date(2026, 5, 9) - timedelta(days=days_back),
        ticker="005930",
        open=close - 100,
        high=close + 200,
        low=close - 200,
        close=close,
        volume=vol,
        trading_value=close * vol,
        foreign_net_buy=0,
        change_rate=0.0,
    )


def _default_inputs(
    graham: AgentOutput,
    dow: AgentOutput,
    *,
    previous: FinalSignal | None = None,
) -> SorosInputs:
    """Build pre-fetched SorosInputs so synthesize() can skip fetch()
    and the real DB."""
    weights = {
        agent: Decimal(str(getattr(DEFAULT_WEIGHTS, agent)))
        for agent in ("simons", "graham", "dow", "shiller", "keynes", "taleb")
    }
    return SorosInputs(
        graham=graham,
        dow=dow,
        weights=weights,
        recent_quotes=[_quote() for _ in range(30)],
        previous_signal=previous,
    )


def _patch_llm(
    monkeypatch: pytest.MonkeyPatch,
    *,
    priced_in: float,
    narrative: str,
) -> None:
    from agents.characters import soros as soros_mod
    from agents.llm.client import ClaudeResult

    call_count = {"n": 0}

    def fake_call(**kwargs: Any) -> tuple[ClaudeResult, Any]:
        call_count["n"] += 1
        if call_count["n"] == 1:
            parsed = soros_mod.SorosPricedIn(
                priced_in=priced_in,
                reason="시장 반영도 평가 결과",
            )
        else:
            parsed = soros_mod.SorosNarrative(narrative=narrative)
        return (
            ClaudeResult(
                text="x",
                model="claude-test",
                input_tokens=10,
                output_tokens=10,
                cost_estimate_usd=0.0,
            ),
            parsed,
        )

    monkeypatch.setattr(soros_mod, "call_claude", fake_call)


def test_synthesize_buy_signal_when_both_positive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Graham +1.5 and Dow +1.0, default weights → expect STRONG_BUY."""
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative=(
            "Graham은 안전마진을 강조하고, Dow는 추세 일치를 보고합니다. "
            "두 의견이 함께 긍정적이며 시장 반영도가 낮은 상태입니다."
        ),
    )

    s = Soros(repo=MagicMock())
    g = _agent_output("graham", "1.5")
    d = _agent_output("dow", "1.0")
    result = s.synthesize(
        ticker="005930",
        cycle_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        graham=g,
        dow=d,
        inputs=_default_inputs(g, d, previous=None),
    )

    sig = result.final_signal
    # Q1: 0.5 × 1.5 + 0.5 × 1.0 = 1.25; priced_in 0.30 < 0.70 so no dampen
    assert sig.weighted_score == Decimal("1.25")
    assert sig.signal_grade == "STRONG_BUY"  # 1.25 ≥ 1.0
    assert "Graham" in sig.narrative
    assert "Dow" in sig.narrative
    assert sig.taleb_override is False
    assert sig.taleb_severity is None
    assert result.change_event is not None  # no previous signal
    assert result.change_event.from_grade is None


def test_synthesize_dampens_when_priced_in_high(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same Q1 score but priced_in 0.85 → halve to ~0.63."""
    _patch_llm(
        monkeypatch,
        priced_in=0.85,
        narrative="시장 반영도가 높아 신호 강도를 절반으로 낮춥니다.",
    )

    s = Soros(repo=MagicMock())
    g = _agent_output("graham", "1.5")
    d = _agent_output("dow", "1.0")
    result = s.synthesize(
        ticker="005930",
        cycle_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        graham=g,
        dow=d,
        inputs=_default_inputs(g, d),
    )

    # Q1 = 1.25 (= 0.5×1.5 + 0.5×1.0), dampened ×0.5 = 0.625 → rounds to 0.63.
    assert result.final_signal.weighted_score == Decimal("0.63")
    # 0.30 ≤ score < 1.00 → BUY band per grade.ts/grading.py.
    assert result.final_signal.signal_grade == "BUY"
    assert (
        result.final_signal.weights_snapshot["priced_in_dampen_applied"] is True
    )


def test_synthesize_no_change_event_when_grade_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="두 분석가 의견 종합.",
    )

    s = Soros(repo=MagicMock())
    g = _agent_output("graham", "1.5")
    d = _agent_output("dow", "1.0")
    result = s.synthesize(
        ticker="005930",
        cycle_at=datetime(2026, 5, 9, 7, 0, tzinfo=UTC),
        graham=g,
        dow=d,
        inputs=_default_inputs(g, d, previous=_final_signal("STRONG_BUY")),
    )

    assert result.final_signal.signal_grade == "STRONG_BUY"
    assert result.change_event is None  # no transition


# Suppress unused-import warning for UUID in some test paths
_ = UUID
