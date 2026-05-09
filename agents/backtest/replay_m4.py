"""Historical replay of the M4 cycle, capturing outputs to CSV.

CLI::

    python -m agents.backtest.replay_m4 \
        --tickers 005930,000660,035420,005380,207940 \
        --dates 2026-04-09,2026-04-16,2026-04-23 \
        --cost-budget 15.0 \
        --out backtest_results.csv

Per (ticker, cycle_at) we write one row with the five voter scores,
Taleb severity, baseline grade, final grade, weighted score, and the
running cost. ``--dry-run`` is implicit — the live DB is never
touched. Already-saved (ticker, date) pairs are skipped on resume.

Cost budget: when the running total reaches ``--cost-budget``, the
replay stops *before* the next ticker, writes a final report, and
exits 0. Partial output is preserved.
"""
from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from datetime import date as Date
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

from agents.characters import _data as data_mod
from agents.characters import dow as dow_mod
from agents.characters import graham as graham_mod
from agents.characters import keynes as keynes_mod
from agents.characters import shiller as shiller_mod
from agents.characters import taleb as taleb_mod
from agents.characters._base import InsufficientDataError
from agents.characters.dow import Dow
from agents.characters.graham import Graham
from agents.characters.keynes import Keynes
from agents.characters.shiller import Shiller
from agents.characters.soros import Soros
from agents.characters.taleb import Taleb
from agents.db.models import (
    AgentName,
    AgentOutput,
    AgentOutputNew,
    SignalChangeEvent,
)


# ─── CSV schema ──────────────────────────────────────────────────────


CSV_FIELDS: tuple[str, ...] = (
    "cycle_at",
    "ticker",
    "graham_score",
    "dow_score",
    "shiller_score",
    "keynes_score",
    "taleb_score",
    "taleb_severity",
    "q1_score",
    "priced_in",
    "weighted_score",
    "baseline_grade",
    "final_grade",
    "constraint_applied",
    "voters_dropped",
    "ticker_cost_usd",
    "running_cost_usd",
)


@dataclass
class ReplayState:
    out_path: Path
    cost_budget_usd: float
    running_cost_usd: float = 0.0
    rows_written: int = 0
    skipped_existing: int = 0
    cap_hit: bool = False


def _patch_data_helpers(as_of: Date) -> dict[str, Any]:
    """Override the time-series fetch helpers in every character module
    so they read history capped at ``as_of``. Returns the originals so
    the caller can restore."""
    originals: dict[str, Any] = {}
    target_modules = (
        ("dow_daily", dow_mod, "daily_quotes"),
        ("graham_daily", graham_mod, "daily_quotes"),
        ("taleb_daily", taleb_mod, "daily_quotes"),
        ("shiller_daily", shiller_mod, "daily_quotes"),
        ("keynes_daily", keynes_mod, "daily_quotes"),
        ("shiller_global", shiller_mod, "global_quotes"),
        ("keynes_global", keynes_mod, "global_quotes"),
        ("soros_daily", __import__(
            "agents.characters.soros", fromlist=["daily_quotes"]
        ), "daily_quotes"),
    )
    for key, mod, attr in target_modules:
        if not hasattr(mod, attr):
            continue
        originals[key] = (mod, attr, getattr(mod, attr))
        if attr == "daily_quotes":
            def _patched_daily(
                ticker: str,
                days: int = 252,
                as_of: Date | None = None,  # noqa: ARG001 — override
                client: Any = None,
                _orig: Any = data_mod.daily_quotes,
                _cutoff: Date = as_of,
            ) -> Any:
                return _orig(ticker, days, as_of=_cutoff, client=client)
            setattr(mod, attr, _patched_daily)
        else:
            def _patched_global(
                symbol: str,
                days: int = 60,
                as_of: Date | None = None,  # noqa: ARG001
                client: Any = None,
                _orig: Any = data_mod.global_quotes,
                _cutoff: Date = as_of,
            ) -> Any:
                return _orig(symbol, days, as_of=_cutoff, client=client)
            setattr(mod, attr, _patched_global)
    return originals


def _restore(originals: dict[str, Any]) -> None:
    for _, (mod, attr, orig) in originals.items():
        setattr(mod, attr, orig)


def _make_dry_run_repo() -> Any:
    """A MagicMock configured for dry-run replay.

    Soros.fetch_m3 calls ``repo.latest_final_signal(ticker)`` to detect
    grade changes. A bare MagicMock returns another MagicMock there,
    which Pydantic later rejects when constructing SignalChangeEventNew
    (the ``from_grade`` literal-validation and ``from_signal_id`` UUID
    parsing both blow up). For replay we don't need cross-cycle state —
    every replayed cycle is a "fresh" signal. Returning None makes
    detect_grade_change report ``did_change=True`` with ``from_grade=None``,
    which Pydantic accepts.
    """
    repo = MagicMock()
    repo.latest_final_signal.return_value = None
    return repo


def _stamp(out: AgentOutputNew) -> AgentOutput:
    """Wrap a fresh AgentOutputNew in a synthetic AgentOutput so Soros
    has a uuid + created_at to reference. Mirrors the dry-run helper
    in run_m2_cycle."""
    return AgentOutput(
        id=uuid4(),
        **out.model_dump(),
        created_at=datetime.now(UTC),
    )


def _load_existing_keys(out_path: Path) -> set[tuple[str, str]]:
    if not out_path.exists():
        return set()
    keys: set[tuple[str, str]] = set()
    with out_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            keys.add((row["cycle_at"], row["ticker"]))
    return keys


def _open_writer(out_path: Path) -> tuple[Any, Any]:
    """Open the CSV in append mode, writing the header only if new."""
    is_new = not out_path.exists()
    f = out_path.open("a", encoding="utf-8", newline="")
    writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
    if is_new:
        writer.writeheader()
        f.flush()
    return f, writer


def _replay_one(
    *,
    ticker: str,
    cycle_at: datetime,
    soros: Soros,
    graham: Graham,
    dow: Dow,
    shiller: Shiller,
    keynes: Keynes,
    taleb: Taleb,
) -> tuple[dict[str, Any] | None, float, list[str]]:
    """Run one (ticker, cycle_at). Returns (csv_row, cost, dropped).
    csv_row is None when every voter raised InsufficientData."""
    voters: dict[AgentName, AgentOutput] = {}
    cost = 0.0
    dropped: list[str] = []

    for name, char in (
        ("graham", graham),
        ("dow", dow),
        ("shiller", shiller),
        ("keynes", keynes),
        ("taleb", taleb),
    ):
        try:
            out = char.analyze(ticker, cycle_at)
            voters[name] = _stamp(out)  # type: ignore[arg-type]
            cost += float(out.cost_estimate or 0)
        except InsufficientDataError as exc:
            dropped.append(f"{name}={exc.reason}")
        except Exception as exc:  # noqa: BLE001
            dropped.append(f"{name}=error:{exc}")

    if not voters:
        return None, cost, dropped

    synth = soros.synthesize_m4(
        ticker=ticker, cycle_at=cycle_at, voters=voters
    )
    cost += float(synth.cost_estimate_usd)

    snap = synth.final_signal.weights_snapshot

    def _score_or_blank(agent: str) -> str:
        v = voters.get(agent)  # type: ignore[arg-type]
        return f"{float(v.score):.4f}" if v and v.score is not None else ""

    taleb_voter = voters.get("taleb")  # type: ignore[arg-type]

    row = {
        "cycle_at": cycle_at.isoformat(),
        "ticker": ticker,
        "graham_score": _score_or_blank("graham"),
        "dow_score": _score_or_blank("dow"),
        "shiller_score": _score_or_blank("shiller"),
        "keynes_score": _score_or_blank("keynes"),
        "taleb_score": _score_or_blank("taleb"),
        "taleb_severity": (
            str(taleb_voter.severity)
            if taleb_voter is not None and taleb_voter.severity is not None
            else ""
        ),
        "q1_score": f"{snap.get('q1_score', 0):.4f}",
        "priced_in": f"{snap.get('priced_in', 0):.4f}",
        "weighted_score": (
            f"{float(synth.final_signal.weighted_score):.4f}"
            if synth.final_signal.weighted_score is not None
            else ""
        ),
        "baseline_grade": snap.get("baseline_grade", ""),
        "final_grade": synth.final_signal.signal_grade,
        "constraint_applied": str(snap.get("taleb_constraint_applied", False)),
        "voters_dropped": ";".join(dropped),
        "ticker_cost_usd": f"{cost:.5f}",
        "running_cost_usd": "",  # caller fills in
    }
    return row, cost, dropped


def run_replay(
    *,
    tickers: list[str],
    dates: list[Date],
    cost_budget_usd: float,
    out_path: Path,
    soros_repo: Any | None = None,
) -> ReplayState:
    """Walk every (date, ticker) cross-product, replay M4, append rows.

    Resumes from existing CSV (idempotent on (cycle_at, ticker)). Stops
    before the next ticker once running_cost_usd ≥ cost_budget_usd.
    """
    state = ReplayState(out_path=out_path, cost_budget_usd=cost_budget_usd)
    existing = _load_existing_keys(out_path)

    soros = Soros(repo=soros_repo or _make_dry_run_repo())
    graham, dow_, shi, key, tal = Graham(), Dow(), Shiller(), Keynes(), Taleb()

    f_handle, writer = _open_writer(out_path)
    try:
        for d in dates:
            cycle_at = datetime(d.year, d.month, d.day, 7, 0, tzinfo=UTC)
            originals = _patch_data_helpers(d)
            try:
                for ticker in tickers:
                    if state.running_cost_usd >= state.cost_budget_usd:
                        state.cap_hit = True
                        break
                    key_ = (cycle_at.isoformat(), ticker)
                    if key_ in existing:
                        state.skipped_existing += 1
                        continue
                    try:
                        row, cost, _dropped = _replay_one(
                            ticker=ticker,
                            cycle_at=cycle_at,
                            soros=soros,
                            graham=graham,
                            dow=dow_,
                            shiller=shi,
                            keynes=key,
                            taleb=tal,
                        )
                    except Exception as exc:  # noqa: BLE001
                        # Soros itself failed (unlikely with dry-run repo).
                        sys.stderr.write(
                            f"[replay] {ticker} @ {d}: synthesis error: {exc}\n"
                        )
                        continue
                    if row is None:
                        sys.stderr.write(
                            f"[replay] {ticker} @ {d}: all voters dropped: "
                            f"{'; '.join(_dropped) or '(no detail)'}\n"
                        )
                        state.running_cost_usd += cost
                        continue
                    state.running_cost_usd += cost
                    row["running_cost_usd"] = f"{state.running_cost_usd:.5f}"
                    writer.writerow(row)
                    f_handle.flush()
                    state.rows_written += 1
                if state.cap_hit:
                    break
            finally:
                _restore(originals)
    finally:
        f_handle.close()

    return state


# ─── CLI ───────────────────────────────────────────────────────────


def _parse_dates(s: str) -> list[Date]:
    return [Date.fromisoformat(p.strip()) for p in s.split(",") if p.strip()]


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument(
        "--tickers", required=True,
        help="Comma-separated 6-digit tickers",
    )
    p.add_argument(
        "--dates", required=True,
        help="Comma-separated YYYY-MM-DD historical cycle dates",
    )
    p.add_argument(
        "--cost-budget", type=float, default=15.0,
        help="Max accumulated USD spend before halting (default 15)",
    )
    p.add_argument(
        "--out", type=Path, default=Path("backtest_results.csv"),
        help="CSV output path (appended; idempotent on resume)",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
    dates = _parse_dates(args.dates)

    print(f"[replay] {len(tickers)} tickers × {len(dates)} dates → {args.out}")
    print(f"[replay] cost cap: ${args.cost_budget:.2f}")
    state = run_replay(
        tickers=tickers,
        dates=dates,
        cost_budget_usd=args.cost_budget,
        out_path=args.out,
    )
    print(
        f"[replay] done. rows={state.rows_written} "
        f"skipped_existing={state.skipped_existing} "
        f"cost=${state.running_cost_usd:.4f} "
        f"cap_hit={state.cap_hit}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())


# unused import retained for pyright
_ = SignalChangeEvent
