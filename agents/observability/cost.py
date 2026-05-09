"""Cost / volume aggregation for the 8-agent system.

Reads from ``v_agent_output_daily`` (migration 22) which already
groups by agent + day in Postgres. We just shape the rows into typed
dataclasses so callers don't juggle dict keys, and offer a small
:func:`summarize_cost` helper for the daily Telegram alert M2 will
trigger.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from datetime import date as Date

from agents.db.models import AgentName
from agents.db.repository import AgentRepository, get_agent_repository


@dataclass(frozen=True)
class DailyAgentMetrics:
    """One row from ``v_agent_output_daily``."""

    agent_name: AgentName
    cycle_date: Date
    output_count: int
    avg_score: float | None
    severity_4plus_count: int
    total_cost_usd: float
    first_cycle: datetime
    last_cycle: datetime


@dataclass(frozen=True)
class AgentCostSummary:
    """Roll-up across a date window."""

    since: Date
    until: Date
    total_calls: int
    total_cost_usd: float
    severity_4plus_count: int
    by_agent: dict[AgentName, dict[str, float]]
    """Per-agent: ``{calls, cost_usd, severity_4plus}``."""


def fetch_recent_agent_metrics(
    days: int = 14,
    repo: AgentRepository | None = None,
) -> list[DailyAgentMetrics]:
    """Pull the last ``days`` of per-agent rollups, newest first."""
    since = (datetime.now(UTC) - timedelta(days=days)).date()
    sb = (repo or get_agent_repository()).sb
    res = (
        sb.table("v_agent_output_daily")
        .select("*")
        .gte("cycle_date", since.isoformat())
        .order("cycle_date", desc=True)
        .order("agent_name")
        .execute()
    )
    out: list[DailyAgentMetrics] = []
    for row in res.data or []:
        # Postgres returns date/timestamp as ISO strings via PostgREST.
        out.append(
            DailyAgentMetrics(
                agent_name=row["agent_name"],
                cycle_date=Date.fromisoformat(row["cycle_date"]),
                output_count=int(row["output_count"]),
                avg_score=(
                    float(row["avg_score"]) if row.get("avg_score") is not None else None
                ),
                severity_4plus_count=int(row.get("severity_4plus_count") or 0),
                total_cost_usd=float(row.get("total_cost_usd") or 0.0),
                first_cycle=datetime.fromisoformat(
                    row["first_cycle"].replace("Z", "+00:00")
                ),
                last_cycle=datetime.fromisoformat(
                    row["last_cycle"].replace("Z", "+00:00")
                ),
            )
        )
    return out


def summarize_cost(metrics: list[DailyAgentMetrics]) -> AgentCostSummary:
    """Roll a list of daily rollups into a window summary.

    Empty input → an empty summary spanning today→today; callers can
    still safely render it.
    """
    if not metrics:
        today = datetime.now(UTC).date()
        return AgentCostSummary(
            since=today,
            until=today,
            total_calls=0,
            total_cost_usd=0.0,
            severity_4plus_count=0,
            by_agent={},
        )

    by_agent: dict[AgentName, dict[str, float]] = {}
    total_calls = 0
    total_cost = 0.0
    total_sev = 0
    min_date = min(m.cycle_date for m in metrics)
    max_date = max(m.cycle_date for m in metrics)

    for m in metrics:
        bucket = by_agent.setdefault(
            m.agent_name,
            {"calls": 0.0, "cost_usd": 0.0, "severity_4plus": 0.0},
        )
        bucket["calls"] += m.output_count
        bucket["cost_usd"] += m.total_cost_usd
        bucket["severity_4plus"] += m.severity_4plus_count
        total_calls += m.output_count
        total_cost += m.total_cost_usd
        total_sev += m.severity_4plus_count

    return AgentCostSummary(
        since=min_date,
        until=max_date,
        total_calls=total_calls,
        total_cost_usd=total_cost,
        severity_4plus_count=total_sev,
        by_agent=by_agent,
    )
