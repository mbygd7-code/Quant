"""Compute 60-day rolling OLS beta of each KR ticker against sector ETFs.

For each (kr_ticker, etf) pair:
   ticker_return_t = α + β · etf_return_t + ε_t   (t over last N days)

We persist β + R² + n_samples + computed_on. The scorer uses β to
predict KR ticker move from yesterday's ETF move (tomorrow's KR
sector_score before market opens).

Sector → primary ETF:
  반도체     → SOXX
  바이오/헬스 → XBI (small/mid biotech is more representative of KR mid-caps)
  2차전지    → LIT
  자동차     → CARZ
  인터넷/AI  → XLK

Usage:
  python -m scripts.compute_sector_betas --window 60
"""
from __future__ import annotations

import argparse
import math
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client

# Each KR sector → list of candidate ETFs (we compute beta against all,
# scorer picks the one with highest R²)
SECTOR_ETFS: dict[str, list[str]] = {
    "반도체":      ["SOXX", "XLK"],
    "바이오/헬스": ["XBI", "IBB"],
    "2차전지":    ["LIT"],
    "자동차":     ["CARZ"],
    "인터넷/AI":  ["XLK", "SOXX"],         # 일부 게임/AI 인프라는 SOXX와 동조
}


def ols_beta(xs: list[float], ys: list[float]) -> tuple[float, float] | None:
    """Returns (beta, r_squared) or None if degenerate."""
    n = len(xs)
    if n < 10:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0 or syy == 0:
        return None
    beta = sxy / sxx
    r_squared = (sxy ** 2) / (sxx * syy)
    return beta, r_squared


def main(window: int = 60) -> None:
    sb = get_admin_client()

    # 1) Load watchlist tickers + their sectors
    watchlist = (
        sb.table("stocks").select("ticker, sector")
          .eq("is_watchlist", True).execute().data
    ) or []
    if not watchlist:
        print("[betas] no watchlist")
        return

    # 2) Load returns: korea_market change_rate per (ticker, date) over window
    today = Date.today()
    since = (today - timedelta(days=window * 2)).isoformat()

    kr_rows = (
        sb.table("korea_market").select("date, ticker, change_rate")
          .gte("date", since).lte("date", today.isoformat())
          .not_.is_("change_rate", "null")
          .execute().data
    ) or []
    kr_by_ticker: dict[str, dict[str, float]] = {}
    for r in kr_rows:
        kr_by_ticker.setdefault(r["ticker"], {})[r["date"]] = float(r["change_rate"])

    # 3) Load ETF returns
    all_etfs = sorted({etf for etfs in SECTOR_ETFS.values() for etf in etfs})
    etf_rows = (
        sb.table("global_market").select("date, symbol, change_rate")
          .gte("date", since).lte("date", today.isoformat())
          .in_("symbol", all_etfs)
          .not_.is_("change_rate", "null")
          .execute().data
    ) or []
    etf_by_symbol: dict[str, dict[str, float]] = {}
    for r in etf_rows:
        etf_by_symbol.setdefault(r["symbol"], {})[r["date"]] = float(r["change_rate"])

    # 4) Per (ticker, candidate ETF) regression on intersection of dates
    results: list[dict] = []
    for stock in watchlist:
        ticker = stock["ticker"]
        sector = stock["sector"]
        if sector not in SECTOR_ETFS:
            continue
        kr_series = kr_by_ticker.get(ticker, {})
        if len(kr_series) < 10:
            continue
        for etf in SECTOR_ETFS[sector]:
            etf_series = etf_by_symbol.get(etf, {})
            common_dates = sorted(set(kr_series.keys()) & set(etf_series.keys()))
            if len(common_dates) < 10:
                continue
            # Cap to most recent `window` samples
            common_dates = common_dates[-window:]
            xs = [etf_series[d] for d in common_dates]
            ys = [kr_series[d] for d in common_dates]
            res = ols_beta(xs, ys)
            if res is None:
                continue
            beta, r2 = res
            if not (math.isfinite(beta) and math.isfinite(r2)):
                continue
            results.append({
                "kr_ticker":   ticker,
                "etf_symbol":  etf,
                "beta":        round(beta, 4),
                "r_squared":   round(r2, 4),
                "n_samples":   len(common_dates),
                "computed_on": common_dates[-1],
            })

    if not results:
        print("[betas] no results -- check that korea_market has data")
        return

    print(f"[betas] computed {len(results)} (ticker, etf) pairs")
    sb.table("kr_sector_betas").upsert(
        results, on_conflict="kr_ticker,etf_symbol",
    ).execute()
    print("[betas] upsert done")

    # Print samples
    print("\n[verify] highest-R² pairs:")
    for r in sorted(results, key=lambda x: -x["r_squared"])[:10]:
        print(f"  {r['kr_ticker']} ~ {r['etf_symbol']}: "
              f"β={r['beta']:+.3f} R²={r['r_squared']:.3f} n={r['n_samples']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=60)
    args = ap.parse_args()
    main(window=args.window)
