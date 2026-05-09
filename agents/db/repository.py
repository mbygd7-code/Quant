"""Thin CRUD wrapper over the 8 new tables.

Reuses ``db.supabase_client.get_admin_client()`` rather than minting a
new client; the legacy code path stays untouched.

Design notes
------------

* **One repository, many tables.** The 8-agent flow is small enough that
  splitting per-table repositories adds cardboard with no payoff.
* **Pydantic in, Pydantic out.** Every method returns a typed model
  (or ``None``); raw dicts never leak into caller code.
* **Service-role only.** All writes go through the admin client which
  bypasses RLS. Per CLAUDE.md §3-E this module must NEVER be imported
  from ``apps/web/`` or any user-facing surface.
* **No async.** ``supabase-py`` is sync; matching it keeps cron jobs
  simple. Anything that needs async wraps these calls in
  ``run_in_executor`` at the call site.
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from functools import lru_cache
from typing import Any
from uuid import UUID

from agents.db.models import (
    AgentKnowledge,
    AgentKnowledgeNew,
    AgentName,
    AgentOutput,
    AgentOutputNew,
    DailyBriefing,
    DailyBriefingNew,
    FinalSignal,
    FinalSignalNew,
    SignalChangeEvent,
    SignalChangeEventNew,
    SignalGrade,
    SorosWeightAdjustment,
    SorosWeightAdjustmentNew,
    UserWeightSettings,
    UserWeightSettingsNew,
    WeightsBundle,
    WeightSettingsHistory,
    WeightSettingsHistoryNew,
)
from db.supabase_client import get_admin_client
from supabase import Client


def _serialize(payload: Any) -> Any:
    """JSON-friendly conversion. supabase-py uses requests + json
    under the hood, which doesn't know about ``Decimal`` /
    ``datetime`` / ``UUID`` / pydantic models out of the box."""
    if isinstance(payload, dict):
        return {k: _serialize(v) for k, v in payload.items()}
    if isinstance(payload, list):
        return [_serialize(v) for v in payload]
    if isinstance(payload, (datetime, date)):
        return payload.isoformat()
    if isinstance(payload, Decimal):
        # Use string to preserve scale; supabase parses NUMERIC fields
        # from strings without precision loss.
        return str(payload)
    if isinstance(payload, UUID):
        return str(payload)
    return payload


def _row_to_dict(row: Any) -> dict[str, Any]:
    """Pydantic row → dict ready for ``insert``."""
    raw = row.model_dump(mode="python", exclude_none=True)
    return _serialize(raw)


class AgentRepository:
    """Synchronous CRUD wrapper. Use ``get_agent_repository()`` to grab
    the cached singleton."""

    def __init__(self, client: Client | None = None) -> None:
        self.sb: Client = client or get_admin_client()

    # ── 18 · agent_outputs ────────────────────────────────────────

    def insert_agent_output(self, output: AgentOutputNew) -> AgentOutput:
        res = self.sb.table("agent_outputs").insert(_row_to_dict(output)).execute()
        return AgentOutput.model_validate(res.data[0])

    def list_recent_agent_outputs(
        self,
        agent_name: AgentName | None = None,
        ticker: str | None = None,
        limit: int = 50,
    ) -> list[AgentOutput]:
        q = self.sb.table("agent_outputs").select("*")
        if agent_name is not None:
            q = q.eq("agent_name", agent_name)
        if ticker is not None:
            q = q.eq("ticker", ticker)
        res = q.order("cycle_at", desc=True).limit(limit).execute()
        return [AgentOutput.model_validate(r) for r in (res.data or [])]

    def list_taleb_alerts(
        self, since: datetime | None = None, severity_min: int = 4, limit: int = 50
    ) -> list[AgentOutput]:
        q = (
            self.sb.table("agent_outputs")
            .select("*")
            .eq("agent_name", "taleb")
            .gte("severity", severity_min)
        )
        if since is not None:
            q = q.gte("cycle_at", since.isoformat())
        res = q.order("cycle_at", desc=True).limit(limit).execute()
        return [AgentOutput.model_validate(r) for r in (res.data or [])]

    # ── 19 · final_signals ────────────────────────────────────────

    def insert_final_signal(self, signal: FinalSignalNew) -> FinalSignal:
        res = self.sb.table("final_signals").insert(_row_to_dict(signal)).execute()
        return FinalSignal.model_validate(res.data[0])

    def latest_final_signal(self, ticker: str) -> FinalSignal | None:
        res = (
            self.sb.table("final_signals")
            .select("*")
            .eq("ticker", ticker)
            .order("cycle_at", desc=True)
            .limit(1)
            .execute()
        )
        if not res.data:
            return None
        return FinalSignal.model_validate(res.data[0])

    def list_final_signals_at_grade(
        self, grade: SignalGrade, limit: int = 100
    ) -> list[FinalSignal]:
        res = (
            self.sb.table("final_signals")
            .select("*")
            .eq("signal_grade", grade)
            .order("cycle_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [FinalSignal.model_validate(r) for r in (res.data or [])]

    # ── 19 · signal_change_events ─────────────────────────────────

    def insert_signal_change(self, event: SignalChangeEventNew) -> SignalChangeEvent:
        res = (
            self.sb.table("signal_change_events").insert(_row_to_dict(event)).execute()
        )
        return SignalChangeEvent.model_validate(res.data[0])

    def pending_change_notifications(self, limit: int = 50) -> list[SignalChangeEvent]:
        """Events not yet pushed to Telegram/Kakao."""
        res = (
            self.sb.table("signal_change_events")
            .select("*")
            .is_("notified_at", "null")
            .order("created_at")
            .limit(limit)
            .execute()
        )
        return [SignalChangeEvent.model_validate(r) for r in (res.data or [])]

    def mark_change_notified(self, event_id: UUID, when: datetime) -> None:
        self.sb.table("signal_change_events").update(
            {"notified_at": when.isoformat()}
        ).eq("id", str(event_id)).execute()

    # ── 19 · daily_briefings ──────────────────────────────────────

    def upsert_daily_briefing(self, brief: DailyBriefingNew) -> DailyBriefing:
        payload = _row_to_dict(brief)
        res = (
            self.sb.table("daily_briefings")
            .upsert(payload, on_conflict="date")
            .execute()
        )
        return DailyBriefing.model_validate(res.data[0])

    def get_daily_briefing(self, on: date) -> DailyBriefing | None:
        res = (
            self.sb.table("daily_briefings")
            .select("*")
            .eq("date", on.isoformat())
            .maybe_single()
            .execute()
        )
        if not res or not res.data:
            return None
        return DailyBriefing.model_validate(res.data)

    # ── 20 · user_weight_settings ─────────────────────────────────

    def get_user_weights(self, user_id: UUID) -> UserWeightSettings | None:
        res = (
            self.sb.table("user_weight_settings")
            .select("*")
            .eq("user_id", str(user_id))
            .maybe_single()
            .execute()
        )
        if not res or not res.data:
            return None
        return UserWeightSettings.model_validate(res.data)

    def upsert_user_weights(
        self, user_id: UUID, weights: WeightsBundle, source: str, note: str | None = None
    ) -> UserWeightSettings:
        """Two-write transaction: snapshot the previous value into
        ``weight_settings_history`` then upsert the new value. We use
        two round-trips because supabase-py doesn't expose explicit
        transactions; the history insert is best-effort. If consistency
        ever matters more than throughput we'll move to an RPC.
        """
        before = self.get_user_weights(user_id)
        before_weights = before.weights if before else None

        new_row = UserWeightSettingsNew(user_id=user_id, weights=weights)
        res = (
            self.sb.table("user_weight_settings")
            .upsert(_row_to_dict(new_row), on_conflict="user_id")
            .execute()
        )
        upserted = UserWeightSettings.model_validate(res.data[0])

        # History insert. Skip on first set if before_weights is None
        # AND source is 'migration' (avoid noise on bulk seeds).
        if not (before_weights is None and source == "migration"):
            history = WeightSettingsHistoryNew(
                user_id=user_id,
                before_weights=before_weights,
                after_weights=weights,
                source=source,  # type: ignore[arg-type]
                note=note,
            )
            self.sb.table("weight_settings_history").insert(
                _row_to_dict(history)
            ).execute()

        return upserted

    def list_weight_history(
        self, user_id: UUID, limit: int = 20
    ) -> list[WeightSettingsHistory]:
        res = (
            self.sb.table("weight_settings_history")
            .select("*")
            .eq("user_id", str(user_id))
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [WeightSettingsHistory.model_validate(r) for r in (res.data or [])]

    # ── 20 · soros_weight_adjustments ─────────────────────────────

    def insert_soros_adjustment(
        self, adj: SorosWeightAdjustmentNew
    ) -> SorosWeightAdjustment:
        # overlay has Decimal values; route through _serialize
        payload = _row_to_dict(adj)
        res = (
            self.sb.table("soros_weight_adjustments").insert(payload).execute()
        )
        return SorosWeightAdjustment.model_validate(res.data[0])

    def active_soros_adjustment(
        self, at: datetime
    ) -> SorosWeightAdjustment | None:
        """Most recent overlay whose validity window covers ``at``."""
        res = (
            self.sb.table("soros_weight_adjustments")
            .select("*")
            .lte("cycle_at", at.isoformat())
            .or_(f"valid_until.is.null,valid_until.gte.{at.isoformat()}")
            .order("cycle_at", desc=True)
            .limit(1)
            .execute()
        )
        if not res.data:
            return None
        return SorosWeightAdjustment.model_validate(res.data[0])

    # ── 21 · agent_knowledge ──────────────────────────────────────

    def insert_knowledge(self, knowledge: AgentKnowledgeNew) -> AgentKnowledge:
        res = (
            self.sb.table("agent_knowledge").insert(_row_to_dict(knowledge)).execute()
        )
        return AgentKnowledge.model_validate(res.data[0])

    def list_knowledge(
        self, agent_name: AgentName, limit: int = 50
    ) -> list[AgentKnowledge]:
        res = (
            self.sb.table("agent_knowledge")
            .select("*")
            .eq("agent_name", agent_name)
            .order("created_at", desc=True)
            .limit(limit)
            .execute()
        )
        return [AgentKnowledge.model_validate(r) for r in (res.data or [])]


@lru_cache(maxsize=1)
def get_agent_repository() -> AgentRepository:
    """Cached singleton — same lifecycle as ``get_admin_client()``."""
    return AgentRepository()
