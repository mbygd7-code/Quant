"""M4 cycle runner — Graham + Dow + Shiller + Keynes + Taleb → Soros (5-voter).

Mirrors ``run_m3_cycle`` with one extra character (Taleb) and the
Q3 auto-constraint flowing through ``soros.synthesize_m4``. Per-
character isolation and the partial-voter contract are unchanged.

Run via::

    python -m agents.cycle.run_m4_cycle               # all watchlist
    python -m agents.cycle.run_m4_cycle --tickers 005930,000660
    python -m agents.cycle.run_m4_cycle --dry-run
"""
from __future__ import annotations

import argparse
import sys
from datetime import UTC, datetime
from uuid import UUID

from agents.characters import InsufficientDataError
from agents.characters._data import daily_quotes, global_quotes
from agents.characters.dow import Dow
from agents.characters.graham import Graham
from agents.characters.keynes import Keynes
from agents.characters.shiller import Shiller
from agents.characters.soros import Soros
from agents.characters.taleb import Taleb
from agents.characters.turing import Turing
from agents.cycle._change_detect import (
    MACRO_SHOCK_SYMBOLS,
    should_reanalyze,
)
from agents.cycle.run_m2_cycle import (
    CycleReport,
    TickerOutcome,
    _stamp,
    _watchlist_tickers,
)
from agents.cycle._favorites import favorites_union
from agents.db.models import (
    AgentName,
    AgentOutput,
    AgentOutputNew,
    SignalChangeEventNew,
)
from agents.db.repository import AgentRepository, get_agent_repository

#: Order matters for narrative readability — Graham (value), Dow
#: (trend), Shiller (cycle), Keynes (macro), Taleb (risk last so its
#: severity is the last thing the LLM saw before grade derivation).
M4_CHARACTER_ORDER: tuple[tuple[AgentName, type], ...] = (
    ("graham", Graham),
    ("dow", Dow),
    ("turing", Turing),    # technical patterns (RSI + MACD + Bollinger)
    ("shiller", Shiller),
    ("keynes", Keynes),
    ("taleb", Taleb),
)


def _persist_or_stamp(
    out: AgentOutputNew, repo: AgentRepository, *, dry_run: bool
) -> AgentOutput:
    return _stamp(out) if dry_run else repo.insert_agent_output(out)


def run_cycle(
    *,
    cycle_at: datetime | None = None,
    tickers: list[str] | None = None,
    tiers: list[str] | None = None,
    favorites_only: bool = False,
    require_change: bool = False,
    user_id: UUID | None = None,
    dry_run: bool = False,
    repo: AgentRepository | None = None,
) -> CycleReport:
    """Run one M4 cycle.

    Args:
        tiers: Filter watchlist to these tier letters (S/A/B). ``None``
            keeps the full universe (legacy behaviour).
        require_change: When True, skip a ticker whose price/volume have
            been quiet AND no macro factor has shocked. Drops LLM cost
            on calm days by 30-50% without altering algorithm semantics
            — the skip just reuses the previous cycle's outputs implicit
            in the absence of a fresh row.
    """
    cycle_at = cycle_at or datetime.now(UTC)
    repo = repo or get_agent_repository()

    # Universe selection order of precedence:
    #   1. explicit --tickers wins (debug / one-off runs)
    #   2. --favorites-only: union of every user's LNB favorites
    #      → falls back to watchlist if no favorites are registered yet
    #   3. --tier filter on the admin watchlist
    #   4. full admin watchlist (legacy default)
    if tickers:
        target_tickers = tickers
    elif favorites_only:
        favs = favorites_union(repo)
        if favs:
            target_tickers = favs
        else:
            # Empty favorites table — fall back so the cron isn't silent.
            # Logged as a warning in the report.
            target_tickers = _watchlist_tickers(repo, tiers=tiers)
    else:
        target_tickers = _watchlist_tickers(repo, tiers=tiers)

    # Cache the macro snapshot once per cycle — every ticker's change-
    # detection check shares the same shock state.
    macro_snapshot: dict[str, list] = {}
    if require_change:
        for sym in MACRO_SHOCK_SYMBOLS:
            try:
                macro_snapshot[sym] = global_quotes(sym, days=5)
            except Exception:  # noqa: BLE001
                macro_snapshot[sym] = []

    report = CycleReport(cycle_at=cycle_at)
    soros = Soros(repo=repo)
    characters = {name: cls() for name, cls in M4_CHARACTER_ORDER}

    for ticker in target_tickers:
        # ── Phase 2: change-detection short-circuit ──────────────
        if require_change:
            try:
                quote_window = daily_quotes(ticker, days=22)
                report_ = should_reanalyze(
                    ticker=ticker,
                    quotes=quote_window,
                    macro_quotes_by_symbol=macro_snapshot,
                )
            except Exception:  # noqa: BLE001
                # Quote fetch failed — be safe and analyse.
                report_ = None
            if report_ is not None and not report_.re_run:
                report.add(
                    TickerOutcome(
                        ticker=ticker,
                        status="skipped",
                        error=f"change-detect: {report_.reason}",
                    )
                )
                continue

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
            except Exception as exc:  # noqa: BLE001
                skip_reasons.append(f"{name}=error:{exc}")

        if not per_voter_outputs:
            report.add(
                TickerOutcome(
                    ticker=ticker,
                    status="skipped",
                    error="; ".join(skip_reasons) or "all voters skipped",
                )
            )
            continue

        try:
            synthesis = soros.synthesize_m4(
                ticker=ticker,
                cycle_at=cycle_at,
                voters=per_voter_outputs,
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

            ticker_cost = per_voter_costs + synthesis.cost_estimate_usd
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
        except Exception as exc:  # noqa: BLE001
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
    p.add_argument(
        "--tier",
        type=str,
        default=None,
        help=(
            "Filter watchlist to these tiers, comma-separated (S,A,B). "
            "Default: no filter. See migration 23."
        ),
    )
    p.add_argument(
        "--require-change",
        action="store_true",
        help=(
            "Skip tickers whose price/volume/macro have all been quiet "
            "since the last cycle. Saves ~30%% of LLM cost on calm days."
        ),
    )
    p.add_argument(
        "--favorites-only",
        action="store_true",
        help=(
            "Restrict expensive LLM analysis to the union of all users' "
            "LNB favorites (migration 24). Data collectors continue to "
            "ingest the full watchlist independently. Falls back to the "
            "full watchlist if no user has favorited anything yet."
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
    tiers = (
        [t.strip().upper() for t in args.tier.split(",") if t.strip()]
        if args.tier
        else None
    )
    user_id = UUID(args.user_id) if args.user_id else None

    report = run_cycle(
        tickers=tickers,
        tiers=tiers,
        favorites_only=args.favorites_only,
        require_change=args.require_change,
        user_id=user_id,
        dry_run=args.dry_run,
    )
    print(report.summary())
    return 0 if report.errors == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
