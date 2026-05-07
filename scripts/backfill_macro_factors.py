"""Backfill macro factor history (USDKRW, ^TNX, WTI) into global_market.

DXY and ^VIX are already collected by the daily pipeline. Only the
three new ones need backfill. yfinance is the single source.

USDKRW: 1 USD priced in KRW. Higher = KRW weakness.
^TNX:   CBOE 10Y Treasury Yield index. The price IS the yield × 10
        (e.g., 4.5% → 45.0). We store as-is; scorer scales.
WTI:    Crude Oil futures. yfinance symbol = "CL=F" but we store as "WTI".

Usage:
  python -m scripts.backfill_macro_factors --days 90
"""
from __future__ import annotations

import argparse
import math
from datetime import date as Date
from datetime import timedelta

import yfinance as yf

from db.supabase_client import get_admin_client

# yfinance symbol → our canonical symbol (matches existing global_market rows)
YF_TO_OURS: dict[str, str] = {
    "KRW=X": "USDKRW",
    "^TNX":  "^TNX",
    "CL=F":  "WTI",
}


def main(days: int = 90) -> None:
    target = Date.today()
    start = target - timedelta(days=days + 5)
    end = target + timedelta(days=2)

    yf_syms = list(YF_TO_OURS.keys())
    print(f"[macro] {yf_syms}, window {start} to {end}")
    df = yf.download(
        tickers=yf_syms, start=start.isoformat(), end=end.isoformat(),
        group_by="ticker", progress=False, threads=True, auto_adjust=False,
    )
    if df is None or df.empty:
        print("[macro] yfinance empty -- aborting")
        return

    rows: list[dict] = []
    for yf_sym, our_sym in YF_TO_OURS.items():
        try:
            ticker_df = df[yf_sym].dropna(subset=["Close"])
            closes = ticker_df["Close"].tolist()
            dates = [d.date() for d in ticker_df.index]
            for i, (d, close) in enumerate(zip(dates, closes)):
                if d < target - timedelta(days=days):
                    continue
                prev = closes[i - 1] if i > 0 else None
                change = (close - prev) / prev if prev else None
                # Asset class: fx for USDKRW, rate for ^TNX, commodity for WTI
                asset_class = (
                    "fx" if our_sym == "USDKRW"
                    else "rate" if our_sym == "^TNX"
                    else "commodity"
                )
                rows.append({
                    "date":        d.isoformat(),
                    "symbol":      our_sym,
                    "close":       float(close),
                    "change_rate": float(change) if change is not None and math.isfinite(change) else None,
                    "volume":      None,
                    "asset_class": asset_class,
                })
        except Exception as exc:
            print(f"  {yf_sym} parse failed: {exc}")

    if not rows:
        print("[macro] no rows produced")
        return
    sb = get_admin_client()
    print(f"[macro] upserting {len(rows)} rows...")
    BATCH = 200
    for i in range(0, len(rows), BATCH):
        sb.table("global_market").upsert(rows[i:i + BATCH], on_conflict="date,symbol").execute()
    print("[macro] done")

    for our_sym in YF_TO_OURS.values():
        sample = (
            sb.table("global_market").select("date, close, change_rate")
              .eq("symbol", our_sym).order("date", desc=True).limit(2)
              .execute().data
        ) or []
        print(f"  {our_sym}: {[(r['date'], r['close']) for r in sample]}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=90)
    args = ap.parse_args()
    main(days=args.days)
