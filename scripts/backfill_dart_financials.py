"""Backfill kr_financials from DART for the 4 most recent reports.

Strategy: try (year, report_code) pairs in descending recency order, take
the first that returns status='000'. DART keeps prior-year values inside
the same response (frmtrm_amount), so we get YoY in one call.

Usage:
  python -m scripts.backfill_dart_financials
"""
from __future__ import annotations

import time
from datetime import date as Date
from typing import Iterator

from collectors.dart import (
    REPORT_CODES,
    extract_financial_metrics,
    extract_prev_year_metrics,
    fetch_single_company_accounts,
    yoy,
)
from db.supabase_client import get_admin_client


def candidate_periods(today: Date) -> Iterator[tuple[int, str]]:
    """Yield (year, reprt_code) tuples in descending recency, with realistic
    filing-window offsets (DART filings open weeks-months after period end).
    """
    y = today.year
    # Annual report (filed Mar-Apr of next year)
    if today >= Date(y, 4, 1):
        yield (y - 1, REPORT_CODES["ANNUAL"])
    # Q3 (Nov filing)
    if today >= Date(y, 11, 15):
        yield (y, REPORT_CODES["Q3"])
    if today >= Date(y, 1, 1):
        yield (y - 1, REPORT_CODES["Q3"])
    # Half-year (Aug filing)
    if today >= Date(y, 8, 15):
        yield (y, REPORT_CODES["H1"])
    yield (y - 1, REPORT_CODES["H1"])
    # Q1 (May filing)
    if today >= Date(y, 5, 15):
        yield (y, REPORT_CODES["Q1"])
    yield (y - 1, REPORT_CODES["Q1"])
    yield (y - 2, REPORT_CODES["ANNUAL"])


def main() -> None:
    sb = get_admin_client()
    pairs = (
        sb.table("kr_corp_codes").select("ticker, corp_code, corp_name").execute().data
    ) or []
    if not pairs:
        print("[financials] kr_corp_codes empty -- run backfill_dart_corpcodes first")
        return
    print(f"[financials] {len(pairs)} ticker → corp_code mappings")

    today = Date.today()
    candidates = list(candidate_periods(today))
    print(f"[financials] trying periods (most-recent first): {candidates[:6]} ...")

    rows: list[dict] = []
    misses: list[str] = []
    for i, p in enumerate(pairs):
        ticker = p["ticker"]
        corp_code = p["corp_code"]
        # Try recent → older until we find the most recent successful filing
        found = False
        for year, reprt_code in candidates:
            try:
                payload = fetch_single_company_accounts(corp_code, year, reprt_code)
            except Exception as exc:
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
            row = {
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
            }
            rows.append(row)
            found = True
            print(f"  [{i + 1:2}/{len(pairs)}] {ticker} {p['corp_name']} → {year}/{reprt_code}: "
                  f"rev_yoy={_pct(row['revenue_yoy'])} op_yoy={_pct(row['op_income_yoy'])}")
            break
        if not found:
            misses.append(f"{ticker} ({p['corp_name']})")

    print(f"\n[financials] success: {len(rows)} / {len(pairs)}")
    if misses:
        print(f"[financials] no recent filings for: {misses[:10]}")
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
    main()
