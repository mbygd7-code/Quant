"""Backfill korea_market with last N days of OHLCV via yfinance.

Why: KR collector ran inconsistently and `korea_market` has gaps. scorer's
volume_flow + risk factors require 5+ historical rows per ticker — without
them they collapse to NEUTRAL(0.5).

Foreign/institution net buy comes from pykrx and isn't covered here (it's
KR-resident IP-only and patchy). Those columns stay NULL — volume_flow
keeps using 0+0 history which is benign (NEUTRAL via zero variance) but
risk_penalty + future change-based factors will work properly.

Usage:
  python -m scripts.backfill_kr_market --days 14
"""
from __future__ import annotations

import argparse
from datetime import date as Date
from datetime import timedelta

import yfinance as yf

from db.supabase_client import get_admin_client


def yf_symbol(ticker: str, market: str) -> str:
    suffix = ".KS" if (market or "KOSPI").upper() == "KOSPI" else ".KQ"
    return f"{ticker}{suffix}"


def main(days: int = 14) -> None:
    sb = get_admin_client()
    target = Date.today()
    start = target - timedelta(days=days + 5)
    end = target + timedelta(days=2)

    watchlist = (
        sb.table("stocks").select("ticker, market")
          .eq("is_watchlist", True).execute().data
    ) or []
    if not watchlist:
        print("[backfill] no watchlist")
        return
    print(f"[backfill] {len(watchlist)} watchlist tickers, window {start} to {end}")

    sym_to_ticker = {yf_symbol(r["ticker"], r["market"] or "KOSPI"): r["ticker"]
                     for r in watchlist}
    df = yf.download(
        tickers=list(sym_to_ticker.keys()),
        start=start.isoformat(), end=end.isoformat(),
        group_by="ticker", progress=False, threads=True, auto_adjust=False,
    )
    if df is None or df.empty:
        print("[backfill] yfinance returned empty -- aborting")
        return

    rows: list[dict] = []
    for sym, ticker in sym_to_ticker.items():
        try:
            ticker_df = df[sym].dropna(subset=["Close"])
            if ticker_df.empty:
                continue
            for ts, row in ticker_df.iterrows():
                d = ts.date()
                if d < target - timedelta(days=days):
                    continue
                close = float(row["Close"])
                # Compute change_rate from yfinance prev close in this window
                idx = ticker_df.index.get_loc(ts)
                prev = float(ticker_df["Close"].iloc[idx - 1]) if idx > 0 else None
                change_rate = (close - prev) / prev if prev else None
                rows.append({
                    "date":         d.isoformat(),
                    "ticker":       ticker,
                    "open":         int(row["Open"]) if not _is_na(row["Open"]) else None,
                    "high":         int(row["High"]) if not _is_na(row["High"]) else None,
                    "low":          int(row["Low"]) if not _is_na(row["Low"]) else None,
                    "close":        int(close),
                    "volume":       int(row["Volume"]) if not _is_na(row["Volume"]) else None,
                    "trading_value": None,
                    "change_rate":  float(change_rate) if change_rate is not None else None,
                })
        except Exception as exc:
            print(f"  {ticker} ({sym}) parse failed: {exc}")

    if not rows:
        print("[backfill] no rows produced")
        return

    print(f"[backfill] upserting {len(rows)} rows...")
    BATCH = 200
    for i in range(0, len(rows), BATCH):
        sb.table("korea_market").upsert(
            rows[i:i + BATCH], on_conflict="date,ticker",
        ).execute()
    print("[backfill] done")

    # Quick verify
    sample = (
        sb.table("korea_market").select("date", count="exact", head=True)
          .eq("ticker", "005930").gte("date", start.isoformat())
          .execute()
    )
    print(f"\n[verify] 005930 rows in window: {sample.count}")


def _is_na(v) -> bool:
    try:
        import math
        return v is None or (isinstance(v, float) and math.isnan(v))
    except Exception:
        return v is None


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=14)
    args = ap.parse_args()
    main(days=args.days)
