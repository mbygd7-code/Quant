"""Tests for Soros' M3 four-voter synthesis."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import date as Date
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from agents.characters._data import KrQuoteRow
from agents.characters.soros import (
    M3_VOTERS,
    PRICED_IN_DAMPEN_THRESHOLD,
    Soros,
    SorosInputsM3,
    voter_shares_for,
    weighted_q1_score_generic,
)
from agents.db.models import AgentName, AgentOutput, FinalSignal
from agents.weights.constants import DEFAULT_WEIGHTS

CYCLE_AT = datetime(2026, 5, 9, 7, 0, tzinfo=UTC)


# ─── voter_shares_for ────────────────────────────────────────────────


def test_shares_default_m3_split() -> None:
    """Default user weights → graham 0.18, dow 0.18, shiller 0.13,
    keynes 0.18. Sum = 0.67 → renormalised."""
    weights = {
        a: Decimal(str(getattr(DEFAULT_WEIGHTS, a)))
        for a in ("simons", "graham", "dow", "shiller", "keynes", "taleb")
    }
    out = voter_shares_for(weights, M3_VOTERS)
    assert set(out) == set(M3_VOTERS)
    total = sum(out.values(), Decimal(0))
    assert abs(total - Decimal(1)) <= Decimal("0.001")
    # Graham, Dow, Keynes equal (0.18 each); Shiller smaller (0.13).
    assert out["graham"] == out["dow"] == out["keynes"]
    assert out["shiller"] < out["graham"]


def test_shares_subset_voters() -> None:
    """Caller can ask for fewer voters; the rest don't dilute the
    normalisation."""
    weights = {
        "graham": Decimal("0.20"),
        "dow": Decimal("0.30"),
    }
    out = voter_shares_for(
        weights, ("graham", "dow")  # type: ignore[arg-type]
    )
    assert out["graham"] == Decimal("0.4")
    assert out["dow"] == Decimal("0.6")


def test_shares_all_zero_falls_back_to_even_split() -> None:
    out = voter_shares_for(
        dict.fromkeys(M3_VOTERS, Decimal(0)),
        M3_VOTERS,
    )
    expected = (Decimal(1) / Decimal(4)).quantize(Decimal("0.0001"))
    for v in M3_VOTERS:
        assert out[v] == expected


def test_shares_empty_voters_returns_empty() -> None:
    assert voter_shares_for({}, ()) == {}


# ─── weighted_q1_score_generic ───────────────────────────────────────


def test_q1_generic_basic() -> None:
    """All present, equal shares."""
    shares = {a: Decimal("0.25") for a in M3_VOTERS}
    scores: dict[AgentName, Decimal | None] = {
        "graham": Decimal("1.0"),
        "dow": Decimal("0.5"),
        "shiller": Decimal("-0.5"),
        "keynes": Decimal("0.0"),
    }
    out = weighted_q1_score_generic(scores, shares)
    # 0.25*(1.0 + 0.5 + -0.5 + 0) = 0.25
    assert out == Decimal("0.25")


def test_q1_generic_skips_missing() -> None:
    """A None score contributes zero — its share is effectively wasted."""
    shares = {a: Decimal("0.25") for a in M3_VOTERS}
    scores: dict[AgentName, Decimal | None] = {
        "graham": Decimal("1.0"),
        "dow": None,
        "shiller": Decimal("1.0"),
        "keynes": Decimal("1.0"),
    }
    out = weighted_q1_score_generic(scores, shares)
    # 3 contribute 1.0 × 0.25 each = 0.75
    assert out == Decimal("0.75")


def test_q1_generic_skewed_shares() -> None:
    """Heavy bias toward keynes."""
    shares = {
        "graham": Decimal("0.10"),
        "dow": Decimal("0.10"),
        "shiller": Decimal("0.10"),
        "keynes": Decimal("0.70"),
    }
    scores: dict[AgentName, Decimal | None] = {
        "graham": Decimal("0.5"),
        "dow": Decimal("0.5"),
        "shiller": Decimal("0.5"),
        "keynes": Decimal("-1.0"),
    }
    # 0.1×0.5×3 + 0.7×-1.0 = 0.15 + (-0.70) = -0.55
    out = weighted_q1_score_generic(scores, shares)
    assert out == Decimal("-0.55")


# ─── full synthesize_m3 flow ────────────────────────────────────────


def _quote(close: int = 60_000, days_back: int = 0) -> KrQuoteRow:
    return KrQuoteRow(
        date=Date(2026, 5, 9) - timedelta(days=days_back),
        ticker="005930",
        open=close - 100,
        high=close + 200,
        low=close - 200,
        close=close,
        volume=1_000_000,
        trading_value=close * 1_000_000,
        foreign_net_buy=0,
        change_rate=0.0,
    )


def _agent_output(agent: str, score: str = "1.0", narrative: str = "ok") -> AgentOutput:
    return AgentOutput(
        id=uuid4(),
        agent_name=agent,  # type: ignore[arg-type]
        ticker="005930",
        cycle_at=CYCLE_AT,
        score=Decimal(score),
        severity=None,
        narrative=narrative,
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
        created_at=CYCLE_AT,
    )


def _final_signal(grade: str = "BUY") -> FinalSignal:
    return FinalSignal(
        id=uuid4(),
        ticker="005930",
        cycle_at=CYCLE_AT,
        signal_grade=grade,  # type: ignore[arg-type]
        weights_snapshot={},
        narrative="prev",
        confidence=Decimal("0.5"),
        weighted_score=Decimal("0.5"),
        taleb_override=False,
        created_at=CYCLE_AT,
    )


def _default_inputs_m3(
    voters: dict[AgentName, AgentOutput],
    *,
    previous: FinalSignal | None = None,
) -> SorosInputsM3:
    weights = {
        a: Decimal(str(getattr(DEFAULT_WEIGHTS, a)))
        for a in ("simons", "graham", "dow", "shiller", "keynes", "taleb")
    }
    return SorosInputsM3(
        voters=voters,
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


def test_synthesize_m3_strong_consensus_buy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All four voters bullish at +1.5 → adjusted ~1.5 → STRONG_BUY."""
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative=(
            "Graham, Dow, Shiller, Keynes 네 분석가 모두 긍정적입니다. "
            "시장 반영도가 낮아 추가 상승 여력이 있어 보입니다."
        ),
    )

    voters: dict[AgentName, AgentOutput] = {
        "graham": _agent_output("graham", "1.5"),
        "dow": _agent_output("dow", "1.5"),
        "shiller": _agent_output("shiller", "1.0"),
        "keynes": _agent_output("keynes", "1.5"),
    }

    s = Soros(repo=MagicMock())
    result = s.synthesize_m3(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_default_inputs_m3(voters),
    )

    sig = result.final_signal
    # Default shares: graham/dow/keynes 0.18, shiller 0.13. Renormalised
    # → graham ≈ 0.269, dow 0.269, shiller 0.194, keynes 0.269.
    # Q1 ≈ 0.269*1.5 + 0.269*1.5 + 0.194*1.0 + 0.269*1.5 ≈ 1.41
    # adjusted = 1.41 (priced_in 0.30 < threshold)
    # 1.41 ≥ 1.0 → STRONG_BUY
    assert sig.signal_grade == "STRONG_BUY"
    assert sig.weighted_score is not None
    assert sig.weighted_score >= Decimal("1.0")
    assert sig.weights_snapshot["milestone"] == "M3"
    assert set(sig.weights_snapshot["voter_set"]) == set(M3_VOTERS)


def test_synthesize_m3_with_three_voters_renormalises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If only three voters are present, their shares re-normalise to
    sum 1.0 — the 4th voter's slot doesn't silently absorb weight."""
    _patch_llm(
        monkeypatch, priced_in=0.30, narrative="Three-voter 시나리오."
    )

    voters: dict[AgentName, AgentOutput] = {
        "graham": _agent_output("graham", "1.0"),
        "dow": _agent_output("dow", "1.0"),
        "shiller": _agent_output("shiller", "1.0"),
        # keynes missing
    }

    s = Soros(repo=MagicMock())
    result = s.synthesize_m3(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_default_inputs_m3(voters),
    )

    snap = result.final_signal.weights_snapshot
    assert "keynes" not in snap["voter_set"]
    shares = snap["shares"]
    total = sum(float(v) for v in shares.values())
    assert abs(total - 1.0) <= 0.001
    # All present scored 1.0 with shares summing to 1 → Q1 = 1.0
    assert result.final_signal.weighted_score == Decimal("1.00")


def test_synthesize_m3_priced_in_dampens(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.85,
        narrative="시장 반영도 높아 신호 강도 절반.",
    )

    voters: dict[AgentName, AgentOutput] = {
        "graham": _agent_output("graham", "1.5"),
        "dow": _agent_output("dow", "1.5"),
        "shiller": _agent_output("shiller", "1.0"),
        "keynes": _agent_output("keynes", "1.5"),
    }

    s = Soros(repo=MagicMock())
    result = s.synthesize_m3(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_default_inputs_m3(voters),
    )

    snap = result.final_signal.weights_snapshot
    assert snap["priced_in_dampen_applied"] is True
    # Q1 ≈ 1.41, dampened ×0.5 ≈ 0.71 → BUY (≥0.30, <1.0)
    assert result.final_signal.signal_grade in ("BUY", "HOLD")


def test_synthesize_m3_emits_change_event_on_first_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="첫 시그널 발행 — 4명 분석가 종합 결과 기록.",
    )
    voters: dict[AgentName, AgentOutput] = {
        a: _agent_output(a, "1.0") for a in M3_VOTERS
    }
    result = Soros(repo=MagicMock()).synthesize_m3(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_default_inputs_m3(voters, previous=None),
    )
    assert result.change_event is not None
    assert result.change_event.from_grade is None


def test_synthesize_m3_no_change_when_grade_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="이전 등급과 동일하게 유지되는 종합 평가입니다.",
    )
    voters: dict[AgentName, AgentOutput] = {
        a: _agent_output(a, "1.5") for a in M3_VOTERS
    }
    # Previous was STRONG_BUY; new should also be STRONG_BUY.
    result = Soros(repo=MagicMock()).synthesize_m3(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_default_inputs_m3(
            voters, previous=_final_signal("STRONG_BUY")
        ),
    )
    assert result.final_signal.signal_grade == "STRONG_BUY"
    assert result.change_event is None


# Ensure the M3 threshold constant is still pulled from the same place
def test_priced_in_threshold_unchanged() -> None:
    assert Decimal("0.70") == PRICED_IN_DAMPEN_THRESHOLD
