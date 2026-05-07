"""Backfill global_market with sector ETF historical data.

Phase A of the 5-layer mapping strategy: a single sector ETF explains
~25-50% of variance in its constituent KR stocks (far more than any
single 1:1 mapping). We use 6 ETFs that cover the 5 watchlist sectors:

  SOXX  — iShares Semiconductor      (반도체)
  XBI   — SPDR S&P Biotech            (바이오/헬스, small/mid)
  IBB   — iShares Biotechnology       (바이오/헬스, large)
  LIT   — Global X Lithium & Battery  (2차전지)
  XLK   — Technology Select           (인터넷/AI)
  CARZ  — First Trust Global Auto     (자동차)

The KR autos sector also tracks DJ Auto+Transport but CARZ is closest.

Usage:
  python -m scripts.backfill_sector_etfs --days 90
"""
from __future__ import annotations

import argparse
import math
from datetime import date as Date
from datetime import timedelta

import yfinance as yf

from db.supabase_client import get_admin_client

ETFS = ["SOXX", "XBI", "IBB", "LIT", "XLK", "CARZ"]


def main(days: int = 90) -> None:
    target = Date.today()
    start = target - timedelta(days=days + 5)
    end = target + timedelta(days=2)

    print(f"[etfs] {len(ETFS)} ETFs, window {start} to {end}")
    df = yf.download(
        tickers=ETFS, start=start.isoformat(), end=end.isoformat(),
        group_by="ticker", progress=False, threads=True, auto_adjust=False,
    )
    if df is None or df.empty:
        print("[etfs] yfinance empty -- aborting")
        return

    rows: list[dict] = []
    for sym in ETFS:
        try:
            ticker_df = df[sym].dropna(subset=["Close"])
            closes = ticker_df["Close"].tolist()
            dates = [d.date() for d in ticker_df.index]
            for i, (d, close) in enumerate(zip(dates, closes)):
                if d < target - timedelta(days=days):
                    continue
                prev = closes[i - 1] if i > 0 else None
                change = (close - prev) / prev if prev else None
                rows.append({
                    "date":        d.isoformat(),
                    "symbol":      sym,
                    "close":       float(close),
                    "change_rate": float(change) if change is not None and math.isfinite(change) else None,
                    "volume":      None,
                    "asset_class": "etf",
                })
        except Exception as exc:
            print(f"  {sym} parse failed: {exc}")

    if not rows:
        print("[etfs] no rows produced")
        return

    sb = get_admin_client()
    print(f"[etfs] upserting {len(rows)} rows...")
    BATCH = 200
    for i in range(0, len(rows), BATCH):
        sb.table("global_market").upsert(rows[i:i + BATCH], on_conflict="date,symbol").execute()
    print("[etfs] done")

    for sym in ETFS:
        sample = (
            sb.table("global_market").select("date, close")
              .eq("symbol", sym).order("date", desc=True).limit(2)
              .execute().data
        ) or []
        print(f"  {sym}: {[(r['date'], r['close']) for r in sample]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    args = ap.parse_args()
    main(days=args.days)
