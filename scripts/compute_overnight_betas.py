"""Compute overnight US → KR open lead-lag betas.

For each KR watchlist ticker, regress its daily return on the PREVIOUS
US session return of several candidate US proxies, and keep the proxy
with the highest R²:

    kr_return_t = α + β · us_return_{t-1} + ε

The lag matters: KR trades in its morning (KST) before the US opens that
same calendar day, so yesterday's US close is what gaps the KR open.
Same-date regression (kr_sector_betas) misses this almost entirely.

Validated 2026-05 (120-day window):
    000660 ~ ^SOX(t-1)  ρ≈+0.39   005930 ~ ^SOX(t-1)  ρ≈+0.35

Output → kr_overnight_betas. The price forecast (/api/kr-forecast)
reads (beta, correlation) for the best proxy and applies a day-1 open
gap = beta · (latest overnight US move), gated by R² and decayed for
later horizons.

Usage:
  python -m scripts.compute_overnight_betas --window 120
"""
from __future__ import annotations

import argparse
import math
from datetime import date as Date
from datetime import datetime, timedelta

from db.supabase_client import fetch_all, get_admin_client

# Candidate US proxies per KR sector. We prefer broad INDICES (^SOX,
# ^IXIC, ^GSPC) which have the fullest history and are the cleanest
# overnight signals; sector ETFs are kept as secondary candidates.
SECTOR_PROXIES: dict[str, list[str]] = {
    "반도체":      ["^SOX", "^IXIC", "SOXX"],
    "2차전지":    ["LIT", "^IXIC", "^GSPC"],
    "자동차":     ["CARZ", "^GSPC", "^DJI"],
    "바이오/헬스": ["XBI", "IBB", "^GSPC"],
    "인터넷/AI":  ["^IXIC", "XLK", "^GSPC"],
}
# Every ticker also gets these broad-market fallbacks evaluated.
BROAD_FALLBACKS = ["^GSPC", "^IXIC"]


def _ols(xs: list[float], ys: list[float]) -> tuple[float, float, float] | None:
    """Return (beta, corr, r2) or None if degenerate."""
    n = len(xs)
    if n < 20:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    if sxx == 0 or syy == 0:
        return None
    beta = sxy / sxx
    corr = sxy / math.sqrt(sxx * syy)
    return beta, corr, corr * corr


def main(window: int = 120, dry_run: bool = False) -> None:
    sb = get_admin_client()

    watchlist = (
        sb.table("stocks").select("ticker, sector")
          .eq("is_watchlist", True).execute().data
    ) or []
    if not watchlist:
        print("[overnight] no watchlist")
        return

    today = Date.today()
    since = (today - timedelta(days=window * 2 + 30)).isoformat()

    # KR returns (paginated — ~19k rows).
    kr_rows = fetch_all(
        sb.table("korea_market").select("date, ticker, change_rate")
          .gte("date", since).lte("date", today.isoformat())
          .not_.is_("change_rate", "null")
          .order("date")
    )
    kr_by_ticker: dict[str, dict[str, float]] = {}
    for r in kr_rows:
        kr_by_ticker.setdefault(r["ticker"], {})[r["date"]] = float(r["change_rate"])

    # US proxy returns.
    all_us = sorted(
        {s for lst in SECTOR_PROXIES.values() for s in lst} | set(BROAD_FALLBACKS)
    )
    us_rows = fetch_all(
        sb.table("global_market").select("date, symbol, change_rate")
          .gte("date", since).lte("date", today.isoformat())
          .in_("symbol", all_us)
          .not_.is_("change_rate", "null")
          .order("date")
    )
    us_by_symbol: dict[str, dict[str, float]] = {}
    for r in us_rows:
        us_by_symbol.setdefault(r["symbol"], {})[r["date"]] = float(r["change_rate"])

    def lagged_pairs(
        kr_series: dict[str, float], us_series: dict[str, float]
    ) -> tuple[list[float], list[float]]:
        """Align KR_t with the most recent US session strictly before t
        (within 4 calendar days). Returns (us_prev, kr) value lists."""
        us_dates_sorted = sorted(us_series.keys())
        xs: list[float] = []
        ys: list[float] = []
        for d_str, kr_val in kr_series.items():
            d = datetime.fromisoformat(d_str).date()
            # Find the latest US date < d within 4 days.
            found = None
            for back in range(1, 5):
                cand = (d - timedelta(days=back)).isoformat()
                if cand in us_series:
                    found = cand
                    break
            if found is not None:
                xs.append(us_series[found])
                ys.append(kr_val)
        return xs, ys

    results: list[dict] = []
    for stock in watchlist:
        ticker = stock["ticker"]
        sector = stock.get("sector")
        kr_series = kr_by_ticker.get(ticker, {})
        if len(kr_series) < 20:
            continue
        candidates = list(
            dict.fromkeys((SECTOR_PROXIES.get(sector, []) + BROAD_FALLBACKS))
        )
        best: dict | None = None
        for sym in candidates:
            us_series = us_by_symbol.get(sym, {})
            if len(us_series) < 20:
                continue
            xs, ys = lagged_pairs(kr_series, us_series)
            if len(xs) < 20:
                continue
            xs, ys = xs[-window:], ys[-window:]
            res = _ols(xs, ys)
            if res is None:
                continue
            beta, corr, r2 = res
            if not all(math.isfinite(v) for v in (beta, corr, r2)):
                continue
            row = {
                "kr_ticker":   ticker,
                "us_symbol":   sym,
                "beta":        round(beta, 4),
                "correlation": round(corr, 4),
                "r_squared":   round(r2, 4),
                "n_samples":   len(xs),
                "computed_on": today.isoformat(),
            }
            if best is None or row["r_squared"] > best["r_squared"]:
                best = row
        if best is not None:
            results.append(best)

    if not results:
        print("[overnight] no results")
        return

    print(f"[overnight] computed best proxy for {len(results)} tickers")
    if dry_run:
        print("[overnight] --dry-run: skipping upsert")
    else:
        sb.table("kr_overnight_betas").upsert(
            results, on_conflict="kr_ticker,us_symbol",
        ).execute()
        print("[overnight] upsert done")

    print("\n[verify] strongest overnight links:")
    for r in sorted(results, key=lambda x: -abs(x["correlation"]))[:12]:
        print(f"  {r['kr_ticker']} ~ {r['us_symbol']}(t-1): "
              f"β={r['beta']:+.3f} ρ={r['correlation']:+.3f} "
              f"R²={r['r_squared']:.3f} n={r['n_samples']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=120)
    ap.add_argument("--dry-run", action="store_true", help="compute + print, skip DB upsert")
    args = ap.parse_args()
    main(window=args.window, dry_run=args.dry_run)
