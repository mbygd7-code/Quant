"""Verify that migrations 18-22 are applied and the expected tables /
views / function exist.

Run as::

    python -m agents.db.migrations_check

Exits with code 0 on success, 1 with a per-item report on failure.
Used by M1-T9 (regression test) and any developer onboarding to the
8-agent system.
"""
from __future__ import annotations

import sys
from collections.abc import Iterable

from agents.db.repository import AgentRepository

# Tables introduced by migrations 18-21.
EXPECTED_TABLES: tuple[str, ...] = (
    "agent_outputs",
    "final_signals",
    "signal_change_events",
    "daily_briefings",
    "user_weight_settings",
    "weight_settings_history",
    "soros_weight_adjustments",
    "agent_knowledge",
)

# Views introduced by migration 22.
EXPECTED_VIEWS: tuple[str, ...] = (
    "v_agent_output_daily",
    "v_user_weight_distribution",
    "v_signal_grade_current",
    "v_taleb_alerts_recent",
)


def _probe_table(repo: AgentRepository, name: str) -> str | None:
    """Returns ``None`` on success, error message on failure."""
    try:
        repo.sb.table(name).select("*").limit(0).execute()
    except Exception as exc:
        return f"{name}: {type(exc).__name__}: {exc}"
    return None


def _format_results(label: str, items: Iterable[str], errors: list[str]) -> None:
    print(f"\n[{label}]")
    for name in items:
        if any(name in err for err in errors):
            err = next(err for err in errors if name in err)
            print(f"  [FAIL] {err}")
        else:
            print(f"  [ ok ] {name}")


def main() -> int:
    repo = AgentRepository()
    errors: list[str] = []

    for name in EXPECTED_TABLES + EXPECTED_VIEWS:
        err = _probe_table(repo, name)
        if err is not None:
            errors.append(err)

    _format_results("tables", EXPECTED_TABLES, errors)
    _format_results("views", EXPECTED_VIEWS, errors)

    if errors:
        print(f"\n[FAIL] {len(errors)} probe(s) failed. Run `supabase db push --linked`.")
        return 1
    print(f"\n[OK] all {len(EXPECTED_TABLES) + len(EXPECTED_VIEWS)} relations present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
