"""Backfill global_market with index quotes via yfinance.

Why: Finnhub free tier didn't expose ^IXIC etc. so global_market lacks
all index rows. Run once to populate the last N days so the dashboard
has data immediately, instead of waiting for the next daily pipeline.

Usage:
  python -m scripts.backfill_indices [--days 14]
"""
from __future__ import annotations

import argparse
from datetime import date as Date
from datetime import timedelta

import yfinance as yf

from db.supabase_client import get_admin_client

INDICES = ["^IXIC", "^GSPC", "^SOX", "^DJI", "^RUT", "^VIX"]


def main(days: int = 14) -> None:
    target = Date.today()
    start = target - timedelta(days=days + 5)         # extra cushion for prev_close
    end = target + timedelta(days=2)                  # exclusive

    print(f"[backfill] fetching {INDICES} from {start} to {end}")
    df = yf.download(
        tickers=INDICES,
        start=start.isoformat(), end=end.isoformat(),
        group_by="ticker", progress=False, threads=True, auto_adjust=False,
    )
    if df is None or df.empty:
        print("[backfill] yfinance returned empty -- aborting")
        return

    rows: list[dict] = []
    for sym in INDICES:
        try:
            ticker_df = df[sym].dropna(subset=["Close"])
            if ticker_df.empty:
                print(f"[backfill] {sym}: no data")
                continue
            closes = ticker_df["Close"].tolist()
            dates = [d.date() for d in ticker_df.index]
            for i, (d, close) in enumerate(zip(dates, closes)):
                if d < target - timedelta(days=days):
                    continue
                prev = closes[i - 1] if i > 0 else None
                change_rate = (close - prev) / prev if prev else None
                rows.append({
                    "date":        d.isoformat(),
                    "symbol":      sym,
                    "close":       float(close),
                    "change_rate": float(change_rate) if change_rate is not None else None,
                    "volume":      None,
                    "asset_class": "index",
                })
        except Exception as exc:
            print(f"[backfill] {sym} parse failed: {exc}")

    if not rows:
        print("[backfill] no rows to upsert -- aborting")
        return

    print(f"[backfill] upserting {len(rows)} rows...")
    sb = get_admin_client()
    # PRIMARY KEY (date, symbol) -- upsert handles re-runs idempotently
    res = sb.table("global_market").upsert(rows, on_conflict="date,symbol").execute()
    inserted = len(res.data) if res.data else len(rows)
    print(f"[backfill] done -- {inserted} rows in global_market")

    # Verify dashboard symbols
    print("\n[verify] dashboard 4 indices on latest dates:")
    for sym in ["^IXIC", "^GSPC", "^SOX", "^VIX"]:
        latest = (
            sb.table("global_market").select("date, close, change_rate")
              .eq("symbol", sym).order("date", desc=True).limit(3)
              .execute().data
        ) or []
        print(f"  {sym}: {[(r['date'], r['close'], r['change_rate']) for r in latest]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    args = ap.parse_args()
    main(days=args.days)
