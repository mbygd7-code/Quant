"""Smoke tests for ``agents.db.migrations_check``.

We don't hit the real Supabase here — that's the job of the live
script and the CI ``Agent schema check`` step. This test pins the
*shape* of the check: the table list matches what migrations 18-21
introduce and the view list matches migration 22, so a future
migration that adds a relation but forgets to update the check fails
loudly in unit tests instead of waiting for the CI live probe.
"""
from __future__ import annotations

from agents.db.migrations_check import EXPECTED_TABLES, EXPECTED_VIEWS


def test_expected_tables_match_m1_schema() -> None:
    """Eight tables introduced by migrations 18-21."""
    assert set(EXPECTED_TABLES) == {
        "agent_outputs",
        "final_signals",
        "signal_change_events",
        "daily_briefings",
        "user_weight_settings",
        "weight_settings_history",
        "soros_weight_adjustments",
        "agent_knowledge",
    }


def test_expected_views_match_migration_22() -> None:
    """Four monitoring views introduced by migration 22 (M1-T2)."""
    assert set(EXPECTED_VIEWS) == {
        "v_agent_output_daily",
        "v_user_weight_distribution",
        "v_signal_grade_current",
        "v_taleb_alerts_recent",
    }


def test_no_overlap_between_tables_and_views() -> None:
    """Names are disjoint — a relation is either a table or a view."""
    assert set(EXPECTED_TABLES).isdisjoint(set(EXPECTED_VIEWS))
