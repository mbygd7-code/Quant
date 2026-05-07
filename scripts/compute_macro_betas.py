"""Compute KR ticker × macro factor 60-day OLS beta.

For each (kr_ticker, factor):
  kr_return_t = α + β · factor_change_t + ε_t

We persist β + R². The scorer multiplies today's macro change by β to
get a per-stock macro contribution.

Usage:
  python -m scripts.compute_macro_betas --window 60
"""
from __future__ import annotations

import argparse
import math
from datetime import date as Date, timedelta

from db.supabase_client import get_admin_client

MACRO_FACTORS = ["USDKRW", "^TNX", "^VIX", "DXY", "WTI"]


def ols_beta(xs: list[float], ys: list[float]) -> tuple[float, float] | None:
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
    r2 = (sxy ** 2) / (sxx * syy)
    return beta, r2


def main(window: int = 60) -> None:
    sb = get_admin_client()

    watchlist = (
        sb.table("stocks").select("ticker")
          .eq("is_watchlist", True).execute().data
    ) or []
    if not watchlist:
        print("[macro_betas] no watchlist")
        return

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

    macro_rows = (
        sb.table("global_market").select("date, symbol, change_rate")
          .gte("date", since).lte("date", today.isoformat())
          .in_("symbol", MACRO_FACTORS)
          .not_.is_("change_rate", "null")
          .execute().data
    ) or []
    macro_by_sym: dict[str, dict[str, float]] = {}
    for r in macro_rows:
        macro_by_sym.setdefault(r["symbol"], {})[r["date"]] = float(r["change_rate"])

    results: list[dict] = []
    for stock in watchlist:
        ticker = stock["ticker"]
        kr_series = kr_by_ticker.get(ticker, {})
        if len(kr_series) < 10:
            continue
        for factor in MACRO_FACTORS:
            macro_series = macro_by_sym.get(factor, {})
            common = sorted(set(kr_series) & set(macro_series))
            if len(common) < 10:
                continue
            common = common[-window:]
            xs = [macro_series[d] for d in common]
            ys = [kr_series[d] for d in common]
            res = ols_beta(xs, ys)
            if res is None:
                continue
            beta, r2 = res
            if not (math.isfinite(beta) and math.isfinite(r2)):
                continue
            results.append({
                "kr_ticker":    ticker,
                "macro_factor": factor,
                "beta":         round(beta, 4),
                "r_squared":    round(r2, 4),
                "n_samples":    len(common),
                "computed_on":  common[-1],
            })

    if not results:
        print("[macro_betas] no results")
        return

    print(f"[macro_betas] computed {len(results)} (ticker, factor) pairs")
    sb.table("kr_macro_betas").upsert(
        results, on_conflict="kr_ticker,macro_factor",
    ).execute()
    print("[macro_betas] upsert done")

    print("\n[verify] highest-R² pairs:")
    for r in sorted(results, key=lambda x: -x["r_squared"])[:10]:
        print(f"  {r['kr_ticker']} ~ {r['macro_factor']}: "
              f"β={r['beta']:+.3f} R²={r['r_squared']:.3f} n={r['n_samples']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=60)
    args = ap.parse_args()
    main(window=args.window)
