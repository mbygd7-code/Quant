"""Pydantic v2 row models matching migrations 18-22.

Two flavours per table:

  * ``<Table>``     — full row including ``id`` and ``created_at``,
                      what comes back from a SELECT.
  * ``<Table>New``  — what callers pass to ``insert``; DB-managed
                      defaults (uuid pk, ``created_at``) are omitted.

Constraints encoded here mirror the ``CHECK`` clauses in the SQL so
validation fails loudly *before* a round-trip to Postgres.

This module is import-safe in both the GitHub Actions runner and any
slim runtime — pydantic is its only dependency.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

# ─── Type aliases ────────────────────────────────────────────────────

AgentName = Literal[
    "soros", "taleb", "simons", "graham", "dow", "shiller", "keynes", "turing"
]
"""All 8 character slugs. Matches agent_outputs.agent_name CHECK."""

VotingAgent = Literal["simons", "graham", "dow", "shiller", "keynes", "taleb"]
"""The 6 agents that participate in weighted scoring (Soros + Turing excluded)."""

SignalGrade = Literal["STRONG_BUY", "BUY", "HOLD", "CAUTION", "RISK"]
"""5-grade output band. UI maps this to 강한관심 / 관심 / 관망 / 주의 / 위험."""

KnowledgeType = Literal["lesson", "pattern", "self_critique"]
WeightSource = Literal["user_manual", "soros_recommendation", "admin", "migration"]

Score = Annotated[Decimal, Field(ge=Decimal("-2.00"), le=Decimal("2.00"))]
"""Agent score in the [-2.00, +2.00] range. Use ``Decimal`` so values
round-trip with the Postgres NUMERIC(4,2) without float drift."""

Severity = Annotated[int, Field(ge=1, le=5)]
"""Taleb-only severity 1..5."""

Confidence = Annotated[Decimal, Field(ge=Decimal("0"), le=Decimal("1"))]
"""[0, 1] confidence on a Soros final signal."""

Multiplier = Annotated[Decimal, Field(ge=Decimal("0.5"), le=Decimal("1.5"))]
"""±50% Soros overlay multiplier. Enforced server-side by trigger."""

WeightValue = Annotated[Decimal, Field(ge=Decimal("0.05"), le=Decimal("0.40"))]
"""Per-agent weight in [5%, 40%]."""

TalebFloorWeight = Annotated[Decimal, Field(ge=Decimal("0.10"), le=Decimal("0.40"))]
"""Taleb has a floor of 10% even though the upper bound is the same 40%."""

TickerStr = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Z0-9.\-]{1,12}$"),
]
"""6-digit KR ticker, US ticker, BRK.B / BRK-B share class — anything
the migration's CHECK lets through."""

JsonObject = dict[str, Any]


class _AgentModel(BaseModel):
    """Common config: forbid extras so a typo in a field name fails
    fast, allow ORM-style construction from supabase-py result dicts."""

    model_config = ConfigDict(
        extra="forbid",
        from_attributes=True,
        validate_assignment=True,
        str_strip_whitespace=True,
    )


# ─── 18 · agent_outputs ──────────────────────────────────────────────

class AgentOutputNew(_AgentModel):
    agent_name: AgentName
    cycle_at: datetime
    ticker: TickerStr | None = None
    score: Score | None = None
    severity: Severity | None = None
    narrative: str = Field(min_length=1)
    raw_payload: JsonObject = Field(default_factory=dict)
    model: str | None = Field(default=None, max_length=50)
    cost_estimate: float | None = None

    @field_validator("severity")
    @classmethod
    def _severity_only_for_taleb(cls, v: int | None, info: Any) -> int | None:
        if v is not None and info.data.get("agent_name") != "taleb":
            raise ValueError("severity is only valid when agent_name='taleb'")
        return v


class AgentOutput(AgentOutputNew):
    id: UUID
    created_at: datetime


# ─── 19 · final_signals · signal_change_events · daily_briefings ────

class FinalSignalNew(_AgentModel):
    ticker: TickerStr
    cycle_at: datetime
    signal_grade: SignalGrade
    confidence: Confidence | None = None
    weighted_score: Score | None = None
    weights_snapshot: JsonObject
    narrative: str = Field(min_length=1)
    taleb_severity: Severity | None = None
    taleb_override: bool = False
    cost_estimate: float | None = None


class FinalSignal(FinalSignalNew):
    id: UUID
    created_at: datetime


class SignalChangeEventNew(_AgentModel):
    ticker: TickerStr
    from_grade: SignalGrade | None = None
    to_grade: SignalGrade
    from_signal_id: UUID | None = None
    to_signal_id: UUID
    reason: str = Field(min_length=1)
    taleb_override: bool = False
    notified_at: datetime | None = None


class SignalChangeEvent(SignalChangeEventNew):
    id: UUID
    created_at: datetime


class DailyBriefingNew(_AgentModel):
    date: date
    headline: str = Field(min_length=1, max_length=200)
    summary_md: str = Field(min_length=1)
    top_stocks: list[JsonObject] = Field(default_factory=list)
    risk_alerts: list[JsonObject] = Field(default_factory=list)
    market_regime: str | None = None
    weights_in_use: JsonObject | None = None
    cost_estimate: float | None = None


class DailyBriefing(DailyBriefingNew):
    created_at: datetime
    updated_at: datetime


# ─── 20 · user_weight_settings · history · soros_adjustments ─────────

class WeightsBundle(_AgentModel):
    """The ``weights`` JSONB payload for user_weight_settings.

    Each field is in [0.05, 0.40] (Taleb floor 0.10). The sum-equals-1
    constraint is enforced application-side in
    ``agents/weights/validator.py`` (M1-T4) — we keep this model
    permissive so it can also represent intermediate UI states.
    """

    simons: WeightValue
    graham: WeightValue
    dow: WeightValue
    shiller: WeightValue
    keynes: WeightValue
    taleb: TalebFloorWeight


class UserWeightSettingsNew(_AgentModel):
    user_id: UUID
    weights: WeightsBundle


class UserWeightSettings(UserWeightSettingsNew):
    created_at: datetime
    updated_at: datetime


class WeightSettingsHistoryNew(_AgentModel):
    user_id: UUID
    before_weights: WeightsBundle | None = None
    after_weights: WeightsBundle
    source: WeightSource
    note: str | None = None


class WeightSettingsHistory(WeightSettingsHistoryNew):
    id: UUID
    created_at: datetime


class SorosWeightAdjustmentNew(_AgentModel):
    cycle_at: datetime
    overlay: dict[VotingAgent, Multiplier]
    rationale: str = Field(min_length=1)
    valid_until: datetime | None = None


class SorosWeightAdjustment(SorosWeightAdjustmentNew):
    id: UUID
    created_at: datetime


# ─── 21 · agent_knowledge ────────────────────────────────────────────

class AgentKnowledgeNew(_AgentModel):
    agent_name: AgentName
    knowledge_type: KnowledgeType
    content_md: str = Field(min_length=1)
    source_signal_id: UUID | None = None
    confidence_at_time: Confidence | None = None
    outcome_observed: str | None = None
    outcome_horizon_d: int | None = Field(default=None, gt=0)
    realized_return: Decimal | None = None
    tags: list[str] | None = None


class AgentKnowledge(AgentKnowledgeNew):
    id: UUID
    created_at: datetime
