"""Pydantic model validation for ``agents/db/models.py``.

These tests don't touch Supabase — they exercise the constraint logic
that makes invalid rows fail loudly *before* a round-trip. The DB-level
CHECKs are belt-and-braces against bypasses (e.g., bulk SQL imports).
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from agents.db.models import (
    AgentOutputNew,
    DailyBriefingNew,
    FinalSignalNew,
    SorosWeightAdjustmentNew,
    UserWeightSettingsNew,
    WeightsBundle,
)

NOW = datetime(2026, 5, 9, 1, 23, 45, tzinfo=timezone.utc)


# ─── AgentOutputNew ──────────────────────────────────────────────────

def test_agent_output_minimal_ok() -> None:
    out = AgentOutputNew(
        agent_name="soros",
        cycle_at=NOW,
        narrative="동의 또는 반대 의견 종합",
    )
    assert out.score is None
    assert out.severity is None
    assert out.raw_payload == {}


def test_agent_output_score_bounds_enforced() -> None:
    with pytest.raises(ValidationError):
        AgentOutputNew(
            agent_name="graham",
            cycle_at=NOW,
            score=Decimal("2.50"),
            narrative="overshoot",
        )
    with pytest.raises(ValidationError):
        AgentOutputNew(
            agent_name="graham",
            cycle_at=NOW,
            score=Decimal("-2.01"),
            narrative="undershoot",
        )


def test_agent_output_severity_only_for_taleb() -> None:
    AgentOutputNew(
        agent_name="taleb",
        cycle_at=NOW,
        severity=4,
        narrative="비대칭 위험 감지",
    )
    with pytest.raises(ValidationError, match="severity"):
        AgentOutputNew(
            agent_name="simons",
            cycle_at=NOW,
            severity=3,
            narrative="ML 신호",
        )


def test_agent_output_severity_range() -> None:
    for bad in (0, 6, -1):
        with pytest.raises(ValidationError):
            AgentOutputNew(
                agent_name="taleb",
                cycle_at=NOW,
                severity=bad,
                narrative="x",
            )


def test_agent_output_ticker_format() -> None:
    AgentOutputNew(agent_name="dow", cycle_at=NOW, ticker="005930", narrative="x")
    AgentOutputNew(agent_name="dow", cycle_at=NOW, ticker="BRK.B", narrative="x")
    AgentOutputNew(agent_name="dow", cycle_at=NOW, ticker="BRK-B", narrative="x")
    with pytest.raises(ValidationError):
        AgentOutputNew(
            agent_name="dow", cycle_at=NOW, ticker="lower", narrative="x"
        )
    with pytest.raises(ValidationError):
        AgentOutputNew(
            agent_name="dow", cycle_at=NOW, ticker="WAY-TOO-LONG-12345", narrative="x"
        )


def test_agent_output_invalid_agent_name() -> None:
    with pytest.raises(ValidationError):
        AgentOutputNew(agent_name="markowitz", cycle_at=NOW, narrative="x")  # type: ignore[arg-type]


# ─── FinalSignalNew ──────────────────────────────────────────────────

def test_final_signal_grade_enum_enforced() -> None:
    FinalSignalNew(
        ticker="005930",
        cycle_at=NOW,
        signal_grade="STRONG_BUY",
        weights_snapshot={"simons": "0.20"},
        narrative="강한 모멘텀",
    )
    with pytest.raises(ValidationError):
        FinalSignalNew(
            ticker="005930",
            cycle_at=NOW,
            signal_grade="BIG_BUY",  # type: ignore[arg-type]
            weights_snapshot={},
            narrative="x",
        )


def test_final_signal_confidence_bounds() -> None:
    with pytest.raises(ValidationError):
        FinalSignalNew(
            ticker="005930",
            cycle_at=NOW,
            signal_grade="HOLD",
            confidence=Decimal("1.01"),
            weights_snapshot={},
            narrative="x",
        )


# ─── DailyBriefingNew ────────────────────────────────────────────────

def test_daily_briefing_headline_length() -> None:
    DailyBriefingNew(
        date=NOW.date(),
        headline="x" * 200,
        summary_md="**오늘 시장**\n…",
    )
    with pytest.raises(ValidationError):
        DailyBriefingNew(
            date=NOW.date(),
            headline="x" * 201,
            summary_md="x",
        )


# ─── WeightsBundle ───────────────────────────────────────────────────

def test_weights_bundle_per_agent_range() -> None:
    WeightsBundle(
        simons=Decimal("0.20"),
        graham=Decimal("0.18"),
        dow=Decimal("0.18"),
        shiller=Decimal("0.13"),
        keynes=Decimal("0.18"),
        taleb=Decimal("0.13"),
    )
    with pytest.raises(ValidationError):
        WeightsBundle(
            simons=Decimal("0.04"),  # below 0.05
            graham=Decimal("0.18"),
            dow=Decimal("0.18"),
            shiller=Decimal("0.13"),
            keynes=Decimal("0.18"),
            taleb=Decimal("0.13"),
        )
    with pytest.raises(ValidationError):
        WeightsBundle(
            simons=Decimal("0.41"),  # above 0.40
            graham=Decimal("0.18"),
            dow=Decimal("0.18"),
            shiller=Decimal("0.13"),
            keynes=Decimal("0.18"),
            taleb=Decimal("0.13"),
        )


def test_weights_bundle_taleb_floor_10() -> None:
    """Taleb has a 10% floor even though others can go to 5%."""
    with pytest.raises(ValidationError):
        WeightsBundle(
            simons=Decimal("0.20"),
            graham=Decimal("0.18"),
            dow=Decimal("0.18"),
            shiller=Decimal("0.13"),
            keynes=Decimal("0.18"),
            taleb=Decimal("0.05"),  # below Taleb floor
        )


def test_user_weight_settings_constructs() -> None:
    UserWeightSettingsNew(
        user_id=uuid4(),
        weights=WeightsBundle(
            simons=Decimal("0.20"),
            graham=Decimal("0.18"),
            dow=Decimal("0.18"),
            shiller=Decimal("0.13"),
            keynes=Decimal("0.18"),
            taleb=Decimal("0.13"),
        ),
    )


# ─── SorosWeightAdjustmentNew ────────────────────────────────────────

def test_soros_overlay_multiplier_range() -> None:
    SorosWeightAdjustmentNew(
        cycle_at=NOW,
        overlay={"taleb": Decimal("1.50"), "simons": Decimal("0.50")},
        rationale="고변동성 국면, 위험 가중 ↑",
    )
    with pytest.raises(ValidationError):
        SorosWeightAdjustmentNew(
            cycle_at=NOW,
            overlay={"taleb": Decimal("1.51")},  # above 1.5
            rationale="x",
        )
    with pytest.raises(ValidationError):
        SorosWeightAdjustmentNew(
            cycle_at=NOW,
            overlay={"taleb": Decimal("0.49")},  # below 0.5
            rationale="x",
        )


def test_soros_overlay_voting_agents_only() -> None:
    """Soros and Turing don't get weights, so they can't be in overlay."""
    with pytest.raises(ValidationError):
        SorosWeightAdjustmentNew(
            cycle_at=NOW,
            overlay={"soros": Decimal("1.20")},  # type: ignore[dict-item]
            rationale="x",
        )
    with pytest.raises(ValidationError):
        SorosWeightAdjustmentNew(
            cycle_at=NOW,
            overlay={"turing": Decimal("1.10")},  # type: ignore[dict-item]
            rationale="x",
        )


# ─── extras=forbid sanity ─────────────────────────────────────────────

def test_extras_rejected() -> None:
    """A typo on field name fails loudly rather than getting swallowed."""
    with pytest.raises(ValidationError):
        AgentOutputNew(
            agent_name="soros",
            cycle_at=NOW,
            narrative="x",
            srevity=4,  # type: ignore[call-arg]
        )
