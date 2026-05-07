"""Backfill kr_fundamentals via yfinance .info — forwardPE / ROE / marketCap.

Only the latest snapshot is fetched per run (yfinance.info doesn't expose
historical fundamentals). Stamp it with `target` so the scorer's window
lookup finds the row.

Usage:
  python -m scripts.backfill_kr_fundamentals --date 2026-05-07
  python -m scripts.backfill_kr_fundamentals                # defaults to today
"""
from __future__ import annotations

import argparse
import math
from datetime import date as Date

import yfinance as yf

from db.supabase_client import get_admin_client


def yf_symbol(ticker: str, market: str) -> str:
    suffix = ".KS" if (market or "KOSPI").upper() == "KOSPI" else ".KQ"
    return f"{ticker}{suffix}"


def _is_finite(v) -> bool:
    if v is None:
        return False
    try:
        return math.isfinite(float(v))
    except (TypeError, ValueError):
        return False


def main(target: Date) -> None:
    sb = get_admin_client()
    watchlist = (
        sb.table("stocks").select("ticker, market")
          .eq("is_watchlist", True).execute().data
    ) or []
    if not watchlist:
        print("[fundamentals] no watchlist")
        return
    print(f"[fundamentals] {len(watchlist)} tickers, target {target}")

    rows: list[dict] = []
    for r in watchlist:
        ticker = r["ticker"]
        sym = yf_symbol(ticker, r["market"] or "KOSPI")
        try:
            info = yf.Ticker(sym).info
        except Exception as exc:
            print(f"  {ticker} ({sym}) info failed: {exc}")
            continue

        row = {
            "date":          target.isoformat(),
            "ticker":        ticker,
            "forward_pe":    float(info["forwardPE"])     if _is_finite(info.get("forwardPE"))     else None,
            "trailing_pe":   float(info["trailingPE"])    if _is_finite(info.get("trailingPE"))    else None,
            "price_to_book": float(info["priceToBook"])   if _is_finite(info.get("priceToBook"))   else None,
            "roe":           float(info["returnOnEquity"]) if _is_finite(info.get("returnOnEquity")) else None,
            "market_cap":    int(info["marketCap"])        if _is_finite(info.get("marketCap"))     else None,
            "source":        "yfinance",
        }
        rows.append(row)

    if not rows:
        print("[fundamentals] no rows")
        return

    print(f"[fundamentals] upserting {len(rows)} rows...")
    sb.table("kr_fundamentals").upsert(rows, on_conflict="date,ticker").execute()
    print("[fundamentals] done")

    # Quick stats
    fwd = [r["forward_pe"] for r in rows if r["forward_pe"] is not None]
    roe = [r["roe"] for r in rows if r["roe"] is not None]
    print(f"\n[verify] forward_pe coverage: {len(fwd)}/{len(rows)}, "
          f"min={min(fwd):.2f} max={max(fwd):.2f}" if fwd else "  (no forward_pe data)")
    print(f"[verify] roe coverage:        {len(roe)}/{len(rows)}, "
          f"min={min(roe):.4f} max={max(roe):.4f}" if roe else "  (no roe data)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", type=str, default=None, help="YYYY-MM-DD (defaults today)")
    args = ap.parse_args()
    target = Date.fromisoformat(args.date) if args.date else Date.today()
    main(target)
