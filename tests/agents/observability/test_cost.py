"""Pure-function tests for ``agents.observability.cost.summarize_cost``.

The fetcher hits Supabase and is exercised by the CI live probe;
here we just pin the math.
"""
from __future__ import annotations

from datetime import UTC, datetime
from datetime import date as Date

from agents.observability.cost import (
    AgentCostSummary,
    DailyAgentMetrics,
    summarize_cost,
)


def _row(
    agent: str = "soros",
    on: Date = Date(2026, 5, 9),
    calls: int = 10,
    cost: float = 0.05,
    sev: int = 0,
) -> DailyAgentMetrics:
    return DailyAgentMetrics(
        agent_name=agent,  # type: ignore[arg-type]
        cycle_date=on,
        output_count=calls,
        avg_score=0.1,
        severity_4plus_count=sev,
        total_cost_usd=cost,
        first_cycle=datetime(on.year, on.month, on.day, 7, 0, tzinfo=UTC),
        last_cycle=datetime(on.year, on.month, on.day, 16, 0, tzinfo=UTC),
    )


def test_empty_input_returns_zero_summary() -> None:
    s = summarize_cost([])
    assert s.total_calls == 0
    assert s.total_cost_usd == 0.0
    assert s.severity_4plus_count == 0
    assert s.by_agent == {}
    # since == until == today (UTC).
    assert s.since == s.until


def test_single_row_passes_through() -> None:
    s = summarize_cost([_row(calls=12, cost=0.07, sev=1)])
    assert s.total_calls == 12
    assert abs(s.total_cost_usd - 0.07) < 1e-9
    assert s.severity_4plus_count == 1
    assert s.by_agent["soros"]["calls"] == 12
    assert abs(s.by_agent["soros"]["cost_usd"] - 0.07) < 1e-9
    assert s.by_agent["soros"]["severity_4plus"] == 1


def test_multi_agent_multi_day_aggregates() -> None:
    metrics = [
        _row(agent="soros", on=Date(2026, 5, 8), calls=10, cost=0.04, sev=0),
        _row(agent="soros", on=Date(2026, 5, 9), calls=12, cost=0.05, sev=0),
        _row(agent="taleb", on=Date(2026, 5, 9), calls=8, cost=0.03, sev=2),
        _row(agent="graham", on=Date(2026, 5, 9), calls=20, cost=0.10, sev=0),
    ]
    s = summarize_cost(metrics)
    assert s.total_calls == 50
    assert abs(s.total_cost_usd - 0.22) < 1e-9
    assert s.severity_4plus_count == 2
    assert s.by_agent["soros"]["calls"] == 22
    assert s.by_agent["taleb"]["severity_4plus"] == 2
    assert s.by_agent["graham"]["calls"] == 20
    # Date window covers both observed days.
    assert s.since == Date(2026, 5, 8)
    assert s.until == Date(2026, 5, 9)


def test_summary_dataclass_is_frozen() -> None:
    """Summaries are immutable so concurrent readers can share them."""
    s = AgentCostSummary(
        since=Date(2026, 5, 9),
        until=Date(2026, 5, 9),
        total_calls=0,
        total_cost_usd=0.0,
        severity_4plus_count=0,
        by_agent={},
    )
    try:
        s.total_calls = 99  # type: ignore[misc]
    except Exception:
        return
    raise AssertionError("AgentCostSummary should be frozen")
