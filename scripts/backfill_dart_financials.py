"""Backfill kr_financials from DART — up to N most recent reports per ticker.

Strategy: try (year, report_code) pairs in descending recency order, save
*every* successful response (status='000') up to the requested depth.
DART keeps prior-year values inside the same response (frmtrm_amount),
so we get YoY in one call.

Note 2026-05-10: previous version had a `break` after the first success,
so kr_financials had only 1 quarter per ticker and Graham always raised
"need ≥2 quarters". Removed; default depth is now 8 quarters which gives
Graham 5-quarter rolling windows.

Usage:
  python -m scripts.backfill_dart_financials                # 8 quarters
  python -m scripts.backfill_dart_financials --depth 12     # more history
  python -m scripts.backfill_dart_financials --tickers 005930,000660
"""
from __future__ import annotations

import argparse
import time
from collections.abc import Iterator
from datetime import date as Date

from collectors.dart import (
    REPORT_CODES,
    extract_financial_metrics,
    extract_prev_year_metrics,
    fetch_single_company_accounts,
    yoy,
)
from db.supabase_client import get_admin_client


def candidate_periods(today: Date, years_back: int = 3) -> Iterator[tuple[int, str]]:
    """Yield (year, reprt_code) tuples in descending recency, with realistic
    filing-window offsets (DART filings open weeks-months after period end).

    ``years_back`` controls how far we walk. Default 3 covers ~12 quarters,
    enough for Graham's 5-quarter window plus headroom.
    """
    y = today.year
    # Most-recent first
    if today >= Date(y, 11, 15):
        yield (y, REPORT_CODES["Q3"])
    if today >= Date(y, 8, 15):
        yield (y, REPORT_CODES["H1"])
    if today >= Date(y, 5, 15):
        yield (y, REPORT_CODES["Q1"])
    if today >= Date(y, 4, 1):
        yield (y - 1, REPORT_CODES["ANNUAL"])

    # Walk back year by year through Q3 → H1 → Q1 → ANNUAL.
    for offset in range(1, years_back + 1):
        yr = y - offset
        yield (yr, REPORT_CODES["Q3"])
        yield (yr, REPORT_CODES["H1"])
        yield (yr, REPORT_CODES["Q1"])
        if offset > 1:  # the ``y - 1`` annual is already yielded above
            yield (yr - 1, REPORT_CODES["ANNUAL"])


def main(depth: int = 8, ticker_filter: list[str] | None = None) -> None:
    sb = get_admin_client()
    q = sb.table("kr_corp_codes").select("ticker, corp_code, corp_name")
    if ticker_filter:
        q = q.in_("ticker", ticker_filter)
    pairs = q.execute().data or []
    if not pairs:
        print("[financials] kr_corp_codes empty -- run backfill_dart_corpcodes first")
        return
    print(f"[financials] {len(pairs)} ticker → corp_code mappings, depth={depth}")

    today = Date.today()
    candidates = list(candidate_periods(today))
    print(f"[financials] trying {len(candidates)} periods (most-recent first):")
    print(f"             {candidates[:6]} ...")

    rows: list[dict] = []
    per_ticker_count: dict[str, int] = {}
    for i, p in enumerate(pairs):
        ticker = p["ticker"]
        corp_code = p["corp_code"]
        successes_for_ticker = 0
        for year, reprt_code in candidates:
            if successes_for_ticker >= depth:
                break  # got enough quarters for this ticker
            try:
                payload = fetch_single_company_accounts(corp_code, year, reprt_code)
            except Exception as exc:
                # Don't spam — just note the first 1-2 errors
                if successes_for_ticker == 0:
                    print(f"  {ticker} {year}/{reprt_code} error: {exc}")
                time.sleep(0.5)
                continue
            time.sleep(0.5)
            if payload.get("status") != "000":
                continue
            current = extract_financial_metrics(payload)
            prev = extract_prev_year_metrics(payload)
            if not any(v is not None for v in current.values()):
                continue
            rows.append({
                "ticker":           ticker,
                "fiscal_year":      year,
                "reprt_code":       reprt_code,
                "period_end":       _period_end(year, reprt_code).isoformat(),
                "revenue":          current.get("revenue"),
                "operating_income": current.get("operating_income"),
                "net_income":       current.get("net_income"),
                "revenue_yoy":      yoy(current.get("revenue"),          prev.get("revenue")),
                "op_income_yoy":    yoy(current.get("operating_income"), prev.get("operating_income")),
                "net_income_yoy":   yoy(current.get("net_income"),       prev.get("net_income")),
            })
            successes_for_ticker += 1
        per_ticker_count[ticker] = successes_for_ticker
        print(
            f"  [{i + 1:2}/{len(pairs)}] {ticker} {p['corp_name']} → "
            f"{successes_for_ticker} quarters"
        )

    coverage = {
        "0_quarters": sum(1 for n in per_ticker_count.values() if n == 0),
        "1_quarter":  sum(1 for n in per_ticker_count.values() if n == 1),
        "2-3":        sum(1 for n in per_ticker_count.values() if 2 <= n <= 3),
        "4-7":        sum(1 for n in per_ticker_count.values() if 4 <= n <= 7),
        "8+":         sum(1 for n in per_ticker_count.values() if n >= 8),
    }
    print(f"\n[financials] total rows: {len(rows)} (coverage: {coverage})")

    if rows:
        sb.table("kr_financials").upsert(
            rows, on_conflict="ticker,fiscal_year,reprt_code",
        ).execute()
        print("[financials] upsert done")


def _period_end(year: int, reprt_code: str) -> Date:
    """Approximate period_end date per report code."""
    if reprt_code == REPORT_CODES["Q1"]:     return Date(year, 3, 31)
    if reprt_code == REPORT_CODES["H1"]:     return Date(year, 6, 30)
    if reprt_code == REPORT_CODES["Q3"]:     return Date(year, 9, 30)
    if reprt_code == REPORT_CODES["ANNUAL"]: return Date(year, 12, 31)
    return Date(year, 12, 31)


def _pct(v: float | None) -> str:
    return "--" if v is None else f"{v * 100:+.1f}%"


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--depth", type=int, default=8,
        help="Max successful filings to fetch per ticker (default 8 quarters)",
    )
    ap.add_argument(
        "--tickers", type=str, default=None,
        help="Comma-separated ticker filter (default: all corp_codes)",
    )
    args = ap.parse_args()
    tickers = (
        [t.strip() for t in args.tickers.split(",") if t.strip()]
        if args.tickers
        else None
    )
    main(depth=args.depth, ticker_filter=tickers)
