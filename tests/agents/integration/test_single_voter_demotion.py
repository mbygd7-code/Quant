"""End-to-end pin: a single-voter-driven signal gets demoted.

Reproduces the user-reported '강한 관심 with 50% 신뢰도' paradox and
verifies the full M4 pipeline (Q1 → Q2 priced-in → confidence gate →
Q3 Taleb) now demotes such signals to BUY, with confidence calculated
from voter agreement rather than score magnitude.
"""
from __future__ import annotations

from datetime import UTC, datetime
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
from agents.db.models import AgentName, AgentOutput
from agents.weights.constants import DEFAULT_WEIGHTS

CYCLE_AT = datetime(2026, 5, 9, 7, 0, tzinfo=UTC)


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
        ticker="006400",
        cycle_at=CYCLE_AT,
        created_at=CYCLE_AT,
        score=Decimal(score),
        severity=severity,
        narrative=narrative,
        raw_payload={},
        model="claude-haiku-4-5",
        cost_estimate=0.001,
    )


def _quotes() -> list[KrQuoteRow]:
    """30 days of synthetic flat quotes — priced_in evaluator needs
    non-empty input but the trend itself isn't what we're testing."""
    rows = []
    for _ in range(30):
        rows.append(
            KrQuoteRow(
                date=Date(2026, 5, 9),
                ticker="006400",
                open=300_000, high=300_000, low=300_000, close=300_000,
                volume=100_000, trading_value=300_000 * 100_000,
                foreign_net_buy=0, change_rate=0.0,
            )
        )
    return rows


def _inputs_m4(voters: dict[AgentName, AgentOutput]) -> SorosInputsM3:
    return SorosInputsM3(
        voters=voters,
        weights={k: v for k, v in DEFAULT_WEIGHTS.model_dump().items()},
        recent_quotes=_quotes(),
        previous_signal=None,
    )


def _patch_llm(monkeypatch: pytest.MonkeyPatch, *, priced_in: float = 0.82) -> None:
    """Stub Soros' two LLM calls (priced_in score + narrative) so the
    test runs offline. priced_in defaults to 0.82 to match the
    screenshot scenario where dampening fires."""
    from agents.characters import soros as soros_mod

    def fake_priced_in(self: Any, ticker: str, bundle: Any) -> tuple[Decimal, float, str]:
        return Decimal(str(priced_in)), 0.0, "claude-haiku-4-5"

    def fake_narrative(
        self: Any, ticker: str, bundle: Any, q1: Decimal, priced_in_v: Decimal,
        adjusted: Decimal, baseline: Any, final: Any, sev: int | None,
        ca: bool,
    ) -> tuple[str, float, str, str | None, str | None]:
        # M4 narrative now returns 5-tuple: (narrative, cost, model,
        # short_term, mid_term). Stubs provide harmless test values.
        return (
            "narrative ok",
            0.0,
            "claude-haiku-4-5",
            "1주 단기 전망 stub",
            "1개월 중기 전망 stub",
        )

    monkeypatch.setattr(soros_mod.Soros, "_priced_in_score_m3", fake_priced_in)
    monkeypatch.setattr(soros_mod.Soros, "_narrative_m4", fake_narrative)


# ─── Single-voter-driven signal gets demoted ─────────────────────────


def test_keynes_only_strong_signal_gets_demoted_to_buy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """User-reported scenario:
        Graham/Dow/Shiller/Taleb all at 0, Keynes alone at +2.
        Previously: STRONG_BUY + 50% 'confidence' (paradox)
        Now: BUY + voter-agreement 'confidence' below threshold
    """
    _patch_llm(monkeypatch, priced_in=0.82)
    voters = {
        "graham":  _voter("graham", "0"),
        "dow":     _voter("dow", "0"),
        "shiller": _voter("shiller", "0"),
        "keynes":  _voter("keynes", "2.00", narrative="원달러 -2.55% 거시 순풍"),
        "taleb":   _voter("taleb", "0", severity=None),
    }
    soros = Soros(repo=MagicMock())
    result = soros.synthesize_m4(
        ticker="006400",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )
    sig = result.final_signal
    snapshot = sig.weights_snapshot

    # baseline (before gate) — depends on priced_in. We don't pin it
    # exactly since shares ≠ uniform; just assert the gate observed
    # something worth demoting.
    # The post-gate grade must NOT be STRONG_BUY because confidence is
    # below the floor.
    assert sig.signal_grade in ("BUY", "HOLD")  # demoted from STRONG_BUY/BUY
    assert sig.confidence is not None
    assert sig.confidence < Decimal("0.70")

    # Audit metadata exposes the single-voter situation.
    assert snapshot["active_voter_count"] == 1
    assert snapshot["active_voters"] == ["keynes"]


def test_unanimous_strong_signal_keeps_strong_buy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Control test: when voters DO agree, STRONG_BUY survives the gate."""
    _patch_llm(monkeypatch, priced_in=0.30)  # below dampen threshold
    voters = {
        "graham":  _voter("graham", "1.8"),
        "dow":     _voter("dow", "1.7"),
        "shiller": _voter("shiller", "1.6"),
        "keynes":  _voter("keynes", "1.5"),
        "taleb":   _voter("taleb", "1.0", severity=None),
    }
    soros = Soros(repo=MagicMock())
    result = soros.synthesize_m4(
        ticker="006400",
        cycle_at=CYCLE_AT,
        voters=voters,
        inputs=_inputs_m4(voters),
    )
    sig = result.final_signal
    snapshot = sig.weights_snapshot

    assert sig.signal_grade == "STRONG_BUY"
    assert sig.confidence is not None
    assert sig.confidence >= Decimal("0.70")
    assert snapshot["active_voter_count"] == 5
    assert snapshot["confidence_gate_applied"] is False
