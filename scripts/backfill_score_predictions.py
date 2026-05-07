"""Train ScoreRegressor on history, generate 5-day forecasts for all
watchlist tickers, persist to score_predictions.

Usage:
  python -m scripts.backfill_score_predictions --date 2026-05-07 --horizon 5
"""
from __future__ import annotations

import argparse
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client
from signals.score_regressor import (
    InsufficientDataError,
    ScoreRegressor,
)


def main(target: Date, horizon: int, train_window: int) -> None:
    sb = get_admin_client()
    watchlist = (
        sb.table("stocks").select("ticker")
          .eq("is_watchlist", True).execute().data
    ) or []
    tickers = [r["ticker"] for r in watchlist]
    if not tickers:
        print("[predictions] no watchlist")
        return
    print(f"[predictions] {len(tickers)} tickers, target {target}, horizon {horizon}")

    # Train on history up through `target - 1` so target-day forecast
    # doesn't see its own data.
    train_end = target - timedelta(days=1)
    train_start = train_end - timedelta(days=train_window)
    print(f"[predictions] training window {train_start} to {train_end}")

    reg = ScoreRegressor()
    try:
        result = reg.train(train_start, train_end)
        print(f"[predictions] trained: {result}")
    except InsufficientDataError as exc:
        print(f"[predictions] train failed: {exc}")
        print("[predictions] aborting (need more historical ai_scores)")
        return

    rows: list[dict] = []
    misses: list[str] = []
    for ticker in tickers:
        preds = reg.predict_horizon(ticker, target, horizon_days=horizon)
        if not preds:
            misses.append(ticker)
            continue
        for p in preds:
            rows.append({
                "date":            p.date.isoformat(),
                "ticker":          p.ticker,
                "horizon_day":     p.horizon_day,
                "target_date":     p.target_date.isoformat(),
                "predicted_score": p.predicted_score,
                "lower_95":        p.lower_95,
                "upper_95":        p.upper_95,
                "model_version":   p.model_version,
            })

    if not rows:
        print("[predictions] no rows produced")
        return
    print(f"[predictions] upserting {len(rows)} rows...")
    sb.table("score_predictions").upsert(
        rows, on_conflict="date,ticker,horizon_day",
    ).execute()
    print(f"[predictions] done. misses: {len(misses)}")
    if misses:
        print(f"[predictions]   examples: {misses[:5]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date",          type=str, required=True)
    ap.add_argument("--horizon",       type=int, default=5)
    ap.add_argument("--train-window",  type=int, default=60)
    args = ap.parse_args()
    main(Date.fromisoformat(args.date), args.horizon, args.train_window)
