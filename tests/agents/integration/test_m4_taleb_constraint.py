"""Integration: M4 5-voter synthesis + Q3 Taleb auto-constraint.

These scenarios pin the *behavioural* contract that severity 4 and 5
have the safety-brake effect prescribed by character-taleb.md §3 +
system-weight-settings.md §Taleb auto-constraint.

    F. Strong bull + severity 4   → STRONG_BUY → BUY (one step down)
    G. Strong bull + severity 5   → STRONG_BUY → HOLD (forced)
    H. Mild bull + severity 4     → BUY → HOLD (one step down)
    I. Bear consensus, severity 5 → CAUTION/RISK unaffected (no rule)
    J. Severity 3 (or null)        → no constraint

Synthesis arithmetic stays the same as M3; only the post-Q2 grade
gating changes. We call ``synthesize_m4`` directly with hand-built
voter outputs and a stubbed LLM.
"""
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
    Soros,
    SorosInputsM3,
)
from agents.db.models import (
    AgentName,
    AgentOutput,
)
from agents.weights.constants import DEFAULT_WEIGHTS

CYCLE_AT = datetime(2026, 5, 9, 7, 0, tzinfo=UTC)


# ─── helpers ────────────────────────────────────────────────────────


def _voter(
    agent: AgentName,
    score: str,
    *,
    severity: int | None = None,
    narrative: str = "ok",
) -> AgentOutput:
    return AgentOutput(
        id=uuid4(),
        agent_name=agent,
        ticker="005930",
        cycle_at=CYCLE_AT,
        score=Decimal(score),
        severity=severity,
        narrative=narrative,
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
        created_at=CYCLE_AT,
    )


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


def _inputs_m4(voters: dict[AgentName, AgentOutput]) -> SorosInputsM3:
    weights = {
        agent: Decimal(str(getattr(DEFAULT_WEIGHTS, agent)))
        for agent in ("simons", "graham", "dow", "shiller", "keynes", "taleb")
    }
    return SorosInputsM3(
        voters=voters,
        weights=weights,
        recent_quotes=[_quote() for _ in range(30)],
        previous_signal=None,
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
                reason="시장 반영도 평가 stub",
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


def _bull_voters(taleb_severity: int | None) -> dict[AgentName, AgentOutput]:
    """All five voters strongly bullish + tightly convergent.

    Convergence matters because the M4 synthesizer now runs a
    confidence gate after Q2: a STRONG_BUY (≥+1.00) with low voter
    agreement gets demoted to BUY *before* Taleb's auto-constraint
    fires. To test Q3 (Taleb) in isolation we need voters that
    survive the gate — hence the tight band 1.7..2.0 instead of the
    old 0.0..2.0 spread."""
    return {
        "graham": _voter("graham", "2.0", narrative="안전마진 충분"),
        "dow": _voter("dow", "1.9", narrative="추세 정렬"),
        "shiller": _voter("shiller", "1.8", narrative="시장 정상"),
        "keynes": _voter("keynes", "1.8", narrative="매크로 순풍"),
        "taleb": _voter(
            "taleb", "1.7",
            severity=taleb_severity,
            narrative="변동성 평가 결과",
        ),
    }


def _mild_bull_voters(taleb_severity: int) -> dict[AgentName, AgentOutput]:
    """Q1 lands in BUY range (≥0.30, <1.00) so a one-step Taleb
    downgrade pushes it to HOLD. Tight convergence keeps voter
    confidence above the BUY gate floor (0.50) so the test isolates
    Taleb's effect rather than the new gate's effect."""
    return {
        "graham": _voter("graham", "0.7"),
        "dow": _voter("dow", "0.6"),
        "shiller": _voter("shiller", "0.5"),
        "keynes": _voter("keynes", "0.6"),
        "taleb": _voter(
            "taleb", "0.4", severity=taleb_severity,
            narrative="severity 4 우려 발행",
        ),
    }


# ─── F. Strong bull + severity 4 → BUY (one step down) ──────────────


def test_f_strong_bull_severity4_downgrades_one_step(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative=(
            "Graham, Dow, Shiller, Keynes 모두 긍정적이지만 Taleb이 "
            "severity 4를 발행했습니다. 자동 제약이 한 단계 하향 적용됩니다."
        ),
    )

    voters = _bull_voters(taleb_severity=4)
    s = Soros(repo=MagicMock())
    result = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )

    sig = result.final_signal
    # Q1 is well above +1.00 → baseline STRONG_BUY → severity 4 → BUY.
    assert sig.weights_snapshot["baseline_grade"] == "STRONG_BUY"
    assert sig.signal_grade == "BUY"
    assert sig.weights_snapshot["taleb_constraint_applied"] is True
    assert sig.taleb_severity == 4
    assert result.change_event is not None
    assert result.change_event.reason == "taleb_auto_constraint"


# ─── G. Strong bull + severity 5 → HOLD ─────────────────────────────


def test_g_strong_bull_severity5_forces_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="Taleb severity 5 — STRONG_BUY/BUY가 HOLD로 강제됩니다.",
    )

    voters = _bull_voters(taleb_severity=5)
    s = Soros(repo=MagicMock())
    result = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )

    sig = result.final_signal
    assert sig.weights_snapshot["baseline_grade"] == "STRONG_BUY"
    assert sig.signal_grade == "HOLD"
    assert sig.taleb_severity == 5


# ─── H. Mild bull (BUY) + severity 4 → HOLD ─────────────────────────


def test_h_buy_grade_severity4_drops_to_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="BUY → HOLD 하향. severity 4 자동 제약.",
    )

    voters = _mild_bull_voters(taleb_severity=4)
    s = Soros(repo=MagicMock())
    result = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )

    sig = result.final_signal
    assert sig.weights_snapshot["baseline_grade"] == "BUY"
    assert sig.signal_grade == "HOLD"
    assert sig.weights_snapshot["taleb_constraint_applied"] is True


# ─── I. Bear case + severity 5 — no upgrade rule ───────────────────


def test_i_bear_case_severity5_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """severity 5 only forces STRONG_BUY/BUY → HOLD. CAUTION and RISK
    are already cautious enough; the constraint must NOT touch them
    (no upward bias)."""
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="이미 CAUTION이므로 자동 제약이 추가 작용하지 않습니다.",
    )

    voters = {
        "graham": _voter("graham", "-1.0"),
        "dow": _voter("dow", "-0.8"),
        "shiller": _voter("shiller", "-0.5"),
        "keynes": _voter("keynes", "-0.5"),
        "taleb": _voter("taleb", "-1.0", severity=5),
    }
    s = Soros(repo=MagicMock())
    result = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )

    sig = result.final_signal
    baseline = sig.weights_snapshot["baseline_grade"]
    # baseline is CAUTION or RISK depending on exact arithmetic;
    # whichever it is, severity 5 must NOT change it.
    assert baseline in ("CAUTION", "RISK")
    assert sig.signal_grade == baseline
    assert sig.weights_snapshot["taleb_constraint_applied"] is False


# ─── J. severity 3 (or below) — no constraint ──────────────────────


@pytest.mark.parametrize("severity", [None, 1, 2, 3])
def test_j_low_severity_no_constraint(
    monkeypatch: pytest.MonkeyPatch, severity: int | None
) -> None:
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="일상 위험 수준 — 자동 제약 미적용.",
    )

    voters = _bull_voters(taleb_severity=severity)
    s = Soros(repo=MagicMock())
    result = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )

    sig = result.final_signal
    assert sig.weights_snapshot["taleb_constraint_applied"] is False
    assert sig.signal_grade == sig.weights_snapshot["baseline_grade"]
    assert sig.taleb_severity == severity


# ─── K. Q1 includes Taleb's risk_score ─────────────────────────────


def test_k_taleb_risk_score_included_in_q1(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Taleb's risk_score must contribute to the Q1 weighted sum
    even when severity is below the constraint threshold. Drop it
    by setting Taleb's score very negative and watch Q1 fall."""
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="Taleb의 risk_score가 Q1에 반영됩니다.",
    )

    # Same primary voters; Taleb -2.0 should drag Q1 down.
    bullish_with_calm_taleb = _bull_voters(taleb_severity=2)
    bullish_with_alarmed_taleb = dict(bullish_with_calm_taleb)
    bullish_with_alarmed_taleb["taleb"] = _voter(
        "taleb", "-2.0", severity=2, narrative="risk 강함"
    )

    s = Soros(repo=MagicMock())

    res_calm = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=bullish_with_calm_taleb,
        inputs=_inputs_m4(bullish_with_calm_taleb),
    )
    # Reset call counter for the second call.
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="Taleb -2.0 — Q1 반영.",
    )
    res_alarmed = s.synthesize_m4(
        ticker="005930",
        cycle_at=CYCLE_AT,
        voters=bullish_with_alarmed_taleb,
        inputs=_inputs_m4(bullish_with_alarmed_taleb),
    )

    calm_q1 = res_calm.final_signal.weights_snapshot["q1_score"]
    alarmed_q1 = res_alarmed.final_signal.weights_snapshot["q1_score"]
    assert alarmed_q1 < calm_q1
