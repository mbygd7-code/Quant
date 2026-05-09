"""M3 cycle runner — Graham + Dow + Shiller + Keynes → Soros (4-voter).

CLI shape mirrors ``run_m2_cycle`` so the cron workflow can swap them
with a one-line edit::

    python -m agents.cycle.run_m3_cycle               # all watchlist
    python -m agents.cycle.run_m3_cycle --tickers 005930,000660
    python -m agents.cycle.run_m3_cycle --dry-run

Per-character isolation: if any one of the four voters raises
InsufficientDataError, the cycle drops that voter (the remaining
agents still write their rows) and Soros synthesises with whatever
voters are present. Soros' synthesize_m3 re-normalises shares so
missing voters don't silently inflate someone else's weight.

If *every* voter raises InsufficientData, the ticker is recorded as
'skipped' and the loop continues.
"""
from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from uuid import UUID, uuid4

from agents.characters import InsufficientDataError
from agents.characters.dow import Dow
from agents.characters.graham import Graham
from agents.characters.keynes import Keynes
from agents.characters.shiller import Shiller
from agents.characters.soros import Soros
from agents.cycle.run_m2_cycle import (
    CycleReport,
    TickerOutcome,
    _stamp,
    _watchlist_tickers,
)
from agents.db.models import (
    AgentName,
    AgentOutput,
    AgentOutputNew,
    SignalChangeEventNew,
)
from agents.db.repository import AgentRepository, get_agent_repository

#: Order matters for narrative readability — Graham first (value),
#: then Dow (trend), then Shiller (cycle), then Keynes (macro).
M3_CHARACTER_ORDER: tuple[tuple[AgentName, type], ...] = (
    ("graham", Graham),
    ("dow", Dow),
    ("shiller", Shiller),
    ("keynes", Keynes),
)


def _persist_or_stamp(
    out: AgentOutputNew, repo: AgentRepository, *, dry_run: bool
) -> AgentOutput:
    return _stamp(out) if dry_run else repo.insert_agent_output(out)


def run_cycle(
    *,
    cycle_at: datetime | None = None,
    tickers: list[str] | None = None,
    user_id: UUID | None = None,
    dry_run: bool = False,
    repo: AgentRepository | None = None,
) -> CycleReport:
    cycle_at = cycle_at or datetime.now(UTC)
    repo = repo or get_agent_repository()
    target_tickers = tickers or _watchlist_tickers(repo)

    report = CycleReport(cycle_at=cycle_at)
    soros = Soros(repo=repo)
    characters = {
        name: cls() for name, cls in M3_CHARACTER_ORDER
    }

    for ticker in target_tickers:
        per_voter_outputs: dict[AgentName, AgentOutput] = {}
        per_voter_costs: float = 0.0
        skip_reasons: list[str] = []

        for name, char in characters.items():
            try:
                out = char.analyze(ticker, cycle_at)
                per_voter_outputs[name] = _persist_or_stamp(
                    out, repo, dry_run=dry_run
                )
                per_voter_costs += float(out.cost_estimate or 0)
            except InsufficientDataError as exc:
                skip_reasons.append(f"{name}={exc.reason}")
            except Exception as exc:
                skip_reasons.append(f"{name}=error:{exc}")

        if not per_voter_outputs:
            # Every voter dropped — record a skip and move on.
            report.add(
                TickerOutcome(
                    ticker=ticker,
                    status="skipped",
                    error="; ".join(skip_reasons) or "all voters skipped",
                )
            )
            continue

        try:
            synthesis = soros.synthesize_m3(
                ticker=ticker,
                cycle_at=cycle_at,
                voters=per_voter_outputs,
                user_id=user_id,
            )

            if not dry_run:
                final_signal = repo.insert_final_signal(
                    synthesis.final_signal
                )
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
                per_voter_costs + synthesis.cost_estimate_usd
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
                    error=(
                        "voters_dropped:" + ";".join(skip_reasons)
                        if skip_reasons
                        else None
                    ),
                )
            )
        except Exception as exc:
            report.add(
                TickerOutcome(
                    ticker=ticker,
                    status="error",
                    error=f"soros: {exc}",
                )
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
        help=(
            "UUID of the user whose weights drive Soros (default: "
            "system defaults)"
        ),
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


# Keep uuid4 importable from this module for tests if they need it.
_ = uuid4
