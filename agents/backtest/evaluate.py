"""Evaluate a replay CSV against forward returns.

CLI::

    python -m agents.backtest.evaluate \
        --csv backtest_results.csv \
        --horizons 5,10,20

For each row in the replay CSV we look up:
  * close at ``cycle_at`` (the prediction time)
  * close ``H`` trading days later for each horizon H
  * forward return = (close_after - close_at_cycle) / close_at_cycle

Then group by ``final_grade`` and print per-grade:
  * count
  * mean / median forward return
  * "hit rate" — directionally correct (BUY: ret > 0; CAUTION/RISK:
    ret < 0; HOLD: |ret| < 3%).

Also reports Taleb severity-4+ hit rate (forward 30-day return < -10%).
"""
from __future__ import annotations

import argparse
import csv
import statistics
import sys
from collections import defaultdict
from datetime import datetime
from datetime import date as Date
from pathlib import Path
from typing import Any

from agents.characters._data import daily_quotes


HIT_THRESHOLD_HOLD = 0.03   # |ret| < 3% counts as a HOLD hit
SEVERE_TALEB_HORIZON_DAYS = 30
SEVERE_TALEB_HIT_THRESHOLD = -0.10


def _close_at_or_after(
    ticker: str,
    target: Date,
    *,
    quotes_cache: dict[str, list[Any]],
) -> int | None:
    """Find the close on ``target`` or the next trading day. Returns
    None when we run out of data."""
    if ticker not in quotes_cache:
        # Pull a wide window once per ticker; sort newest-first.
        quotes_cache[ticker] = daily_quotes(ticker, days=400)
    rows = quotes_cache[ticker]
    # rows are newest-first; find the smallest date >= target.
    candidates = [r for r in rows if r.date >= target and r.close is not None]
    if not candidates:
        return None
    # Smallest date that's >= target → last in the newest-first slice.
    candidates.sort(key=lambda r: r.date)
    return candidates[0].close


def _close_at_or_before(
    ticker: str,
    target: Date,
    *,
    quotes_cache: dict[str, list[Any]],
) -> int | None:
    if ticker not in quotes_cache:
        quotes_cache[ticker] = daily_quotes(ticker, days=400)
    rows = quotes_cache[ticker]
    candidates = [r for r in rows if r.date <= target and r.close is not None]
    if not candidates:
        return None
    candidates.sort(key=lambda r: r.date, reverse=True)
    return candidates[0].close


def _forward_return(
    ticker: str,
    cycle_date: Date,
    horizon_days: int,
    quotes_cache: dict[str, list[Any]],
) -> float | None:
    base = _close_at_or_before(ticker, cycle_date, quotes_cache=quotes_cache)
    if base is None or base <= 0:
        return None
    # horizon_days here is calendar days; for a clean trading-day measure
    # we'd walk the rows. Calendar days × 1.4 ≈ trading days conversion
    # is close enough for a mini-backtest.
    target = cycle_date.fromordinal(
        cycle_date.toordinal() + int(horizon_days * 1.4) + 1
    )
    after = _close_at_or_after(ticker, target, quotes_cache=quotes_cache)
    if after is None or after <= 0:
        return None
    return (after - base) / base


def _hit(grade: str, ret: float) -> bool:
    if grade in ("STRONG_BUY", "BUY"):
        return ret > 0
    if grade == "HOLD":
        return abs(ret) < HIT_THRESHOLD_HOLD
    if grade in ("CAUTION", "RISK"):
        return ret < 0
    return False


def evaluate(
    csv_path: Path, horizons: list[int]
) -> dict[str, Any]:
    """Aggregate hit rates per grade and per horizon. Returns a nested
    dict the CLI prints; tests can assert on the structure."""
    quotes_cache: dict[str, list[Any]] = {}

    rows: list[dict[str, str]] = []
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))

    by_grade_horizon: dict[tuple[str, int], list[float]] = defaultdict(list)
    severe_taleb_outcomes: list[tuple[str, Date, float]] = []

    for r in rows:
        cycle_at = datetime.fromisoformat(r["cycle_at"]).date()
        ticker = r["ticker"]
        grade = r["final_grade"]
        for H in horizons:
            ret = _forward_return(ticker, cycle_at, H, quotes_cache)
            if ret is None:
                continue
            by_grade_horizon[(grade, H)].append(ret)

        sev_str = r.get("taleb_severity") or ""
        if sev_str and int(sev_str) >= 4:
            ret_30 = _forward_return(
                ticker, cycle_at, SEVERE_TALEB_HORIZON_DAYS, quotes_cache
            )
            if ret_30 is not None:
                severe_taleb_outcomes.append((ticker, cycle_at, ret_30))

    summary: dict[str, Any] = {"per_grade": {}, "severe_taleb": {}}
    for (grade, H), rets in sorted(by_grade_horizon.items()):
        hits = sum(1 for r in rets if _hit(grade, r))
        summary["per_grade"][f"{grade}@{H}d"] = {
            "n": len(rets),
            "mean_ret": statistics.fmean(rets),
            "median_ret": statistics.median(rets),
            "hit_rate": hits / len(rets) if rets else 0.0,
        }

    if severe_taleb_outcomes:
        big_drops = sum(
            1 for _, _, r in severe_taleb_outcomes
            if r <= SEVERE_TALEB_HIT_THRESHOLD
        )
        rets = [r for _, _, r in severe_taleb_outcomes]
        summary["severe_taleb"] = {
            "n_alerts": len(severe_taleb_outcomes),
            "n_big_drops_30d": big_drops,
            "hit_rate": big_drops / len(severe_taleb_outcomes),
            "mean_30d_ret": statistics.fmean(rets),
        }
    else:
        summary["severe_taleb"] = {"n_alerts": 0}

    return summary


def _format_summary(summary: dict[str, Any]) -> str:
    lines = ["=== M4 mini-backtest ==="]
    lines.append("\nGrade × Horizon hit rates:")
    lines.append(f"  {'key':<22} {'n':>5} {'mean':>8} {'med':>8} {'hit':>6}")
    for key, stats in summary["per_grade"].items():
        lines.append(
            f"  {key:<22} {stats['n']:>5} "
            f"{stats['mean_ret']:>+8.2%} "
            f"{stats['median_ret']:>+8.2%} "
            f"{stats['hit_rate']:>6.1%}"
        )

    sev = summary["severe_taleb"]
    lines.append("\nTaleb severity 4+ (30-day -10% target):")
    if sev.get("n_alerts", 0) == 0:
        lines.append("  no severity-4+ alerts in this replay")
    else:
        lines.append(
            f"  alerts: {sev['n_alerts']}  "
            f"big drops (≤ -10%): {sev['n_big_drops_30d']}  "
            f"hit rate: {sev['hit_rate']:.1%}  "
            f"mean 30d return: {sev['mean_30d_ret']:+.2%}"
        )
    return "\n".join(lines)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--csv", type=Path, required=True)
    p.add_argument(
        "--horizons", default="5,10,20",
        help="Comma-separated forward horizons in calendar days",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    horizons = [int(h) for h in args.horizons.split(",")]
    summary = evaluate(args.csv, horizons)
    print(_format_summary(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
