"""Daily cycle runner — Graham → Dow → Soros for every watchlist ticker.

Run via::

    python -m agents.cycle.run_m2_cycle               # all watchlist tickers
    python -m agents.cycle.run_m2_cycle --tickers 005930,000660
    python -m agents.cycle.run_m2_cycle --dry-run     # analyze + print, no DB write

Per-ticker failure isolation: a single ticker that errors out doesn't
abort the cycle. Errors are accumulated into the CycleReport so the
GitHub Actions step can surface them as artifacts.

Strangler Fig: this module is the *only* new code that calls the
M2 character classes from a cron context. The legacy
``orchestrator/pipeline.py`` keeps running the 7-step pipeline as
before — both run on different cron schedules.
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from uuid import UUID

from agents.characters import InsufficientDataError
from agents.characters.dow import Dow
from agents.characters.graham import Graham
from agents.characters.soros import Soros
from agents.db.models import (
    AgentOutput,
    AgentOutputNew,
    SignalChangeEventNew,
)
from agents.db.repository import AgentRepository, get_agent_repository


@dataclass
class TickerOutcome:
    """Per-ticker result row in the cycle report."""

    ticker: str
    status: str  # "ok" | "skipped" | "error"
    grade: str | None = None
    score: float | None = None
    error: str | None = None
    cost_estimate_usd: float = 0.0


@dataclass
class CycleReport:
    cycle_at: datetime
    tickers_attempted: int = 0
    success: int = 0
    skipped: int = 0
    errors: int = 0
    outcomes: list[TickerOutcome] = field(default_factory=list)
    total_cost_usd: float = 0.0

    def add(self, outcome: TickerOutcome) -> None:
        self.outcomes.append(outcome)
        self.tickers_attempted += 1
        self.total_cost_usd += outcome.cost_estimate_usd
        if outcome.status == "ok":
            self.success += 1
        elif outcome.status == "skipped":
            self.skipped += 1
        else:
            self.errors += 1

    def summary(self) -> str:
        lines = [
            f"M2 cycle @ {self.cycle_at.isoformat()}",
            f"  attempted: {self.tickers_attempted}",
            f"  ok:        {self.success}",
            f"  skipped:   {self.skipped}",
            f"  errors:    {self.errors}",
            f"  cost:      ${self.total_cost_usd:.4f}",
        ]
        # Group recent grades for at-a-glance readout.
        if self.success > 0:
            grade_counts: dict[str, int] = {}
            for o in self.outcomes:
                if o.grade:
                    grade_counts[o.grade] = grade_counts.get(o.grade, 0) + 1
            grades_line = ", ".join(
                f"{g}={n}" for g, n in sorted(grade_counts.items())
            )
            lines.append(f"  grades:    {grades_line}")
        if self.errors > 0:
            lines.append("  errored:")
            for o in self.outcomes:
                if o.status == "error":
                    lines.append(f"    - {o.ticker}: {o.error}")
        return "\n".join(lines)


def _watchlist_tickers(repo: AgentRepository) -> list[str]:
    """Pull stocks where is_watchlist=true. M2 user weight per-user
    is honoured by Soros; M2-T5 itself uses the master watchlist as
    the cycle scope (system-implementation-roadmap.md §M2)."""
    res = (
        repo.sb.table("stocks")
        .select("ticker")
        .eq("is_watchlist", True)
        .execute()
    )
    return [r["ticker"] for r in (res.data or [])]


def _stamp(out: AgentOutputNew) -> AgentOutput:
    """Wrap an AgentOutputNew in a synthetic AgentOutput with fresh
    uuid/timestamp. Used in dry-run so Soros has a proper ``id`` field
    to reference."""
    from uuid import uuid4

    return AgentOutput(
        id=uuid4(),
        **out.model_dump(),
        created_at=datetime.now(UTC),
    )


def run_cycle(
    *,
    cycle_at: datetime | None = None,
    tickers: list[str] | None = None,
    user_id: UUID | None = None,
    dry_run: bool = False,
    repo: AgentRepository | None = None,
) -> CycleReport:
    """Run one M2 cycle.

    ``user_id`` selects whose weight bundle Soros uses; ``None`` means
    fall back to the system DEFAULT_WEIGHTS. Production cron will pass
    ``None`` (system-default) until M3+ when the per-user signal
    branches arrive.
    """
    cycle_at = cycle_at or datetime.now(UTC)
    repo = repo or get_agent_repository()
    target_tickers = tickers or _watchlist_tickers(repo)

    report = CycleReport(cycle_at=cycle_at)
    graham = Graham()
    dow = Dow()
    soros = Soros(repo=repo)

    for ticker in target_tickers:
        try:
            graham_out = graham.analyze(ticker, cycle_at)
            dow_out = dow.analyze(ticker, cycle_at)

            graham_full = (
                _stamp(graham_out) if dry_run
                else repo.insert_agent_output(graham_out)
            )
            dow_full = (
                _stamp(dow_out) if dry_run
                else repo.insert_agent_output(dow_out)
            )

            synthesis = soros.synthesize(
                ticker=ticker,
                cycle_at=cycle_at,
                graham=graham_full,
                dow=dow_full,
                user_id=user_id,
            )

            if not dry_run:
                final_signal = repo.insert_final_signal(synthesis.final_signal)
                if synthesis.change_event is not None:
                    repo.insert_signal_change(
                        SignalChangeEventNew(
                            **{
                                **synthesis.change_event.model_dump(),
                                "to_signal_id": final_signal.id,
                            }
                        )
                    )

            ticker_cost = (
                float(graham_out.cost_estimate or 0)
                + float(dow_out.cost_estimate or 0)
                + synthesis.cost_estimate_usd
            )
            report.add(
                TickerOutcome(
                    ticker=ticker,
                    status="ok",
                    grade=synthesis.final_signal.signal_grade,
                    score=float(synthesis.final_signal.weighted_score)
                    if synthesis.final_signal.weighted_score is not None
                    else None,
                    cost_estimate_usd=ticker_cost,
                )
            )

        except InsufficientDataError as exc:
            report.add(
                TickerOutcome(
                    ticker=ticker, status="skipped", error=exc.reason
                )
            )
        except Exception as exc:  # pragma: no cover - belt and braces
            report.add(
                TickerOutcome(ticker=ticker, status="error", error=str(exc))
            )

    return report


# ─── CLI ───────────────────────────────────────────────────────────


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--tickers",
        type=str,
        default=None,
        help="comma-separated tickers (default: all watchlist)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="run analysis without DB writes; print summary",
    )
    p.add_argument(
        "--user-id",
        type=str,
        default=None,
        help="UUID of the user whose weights drive Soros (default: system defaults)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    tickers = (
        [t.strip() for t in args.tickers.split(",") if t.strip()]
        if args.tickers
        else None
    )
    user_id = UUID(args.user_id) if args.user_id else None

    report = run_cycle(
        tickers=tickers,
        user_id=user_id,
        dry_run=args.dry_run,
    )
    print(report.summary())
    return 0 if report.errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
