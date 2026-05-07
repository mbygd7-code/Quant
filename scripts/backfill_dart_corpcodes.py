"""One-time DART corp_code mapping backfill.

Downloads corpCode.xml zip (~10MB), filters to KR-listed companies that
match our watchlist tickers, upserts kr_corp_codes.

Usage:
  python -m scripts.backfill_dart_corpcodes
"""
from __future__ import annotations

from collectors.dart import fetch_corp_code_zip, parse_corp_codes
from db.supabase_client import get_admin_client


def main() -> None:
    sb = get_admin_client()
    watchlist = (
        sb.table("stocks").select("ticker, name").eq("is_watchlist", True).execute().data
    ) or []
    tickers = {r["ticker"]: r["name"] for r in watchlist}
    if not tickers:
        print("[corp_codes] no watchlist")
        return
    print(f"[corp_codes] watchlist size: {len(tickers)}")

    zip_bytes = fetch_corp_code_zip()
    code_map = parse_corp_codes(zip_bytes)

    rows: list[dict] = []
    missing: list[str] = []
    for ticker, name in tickers.items():
        match = code_map.get(ticker)
        if not match:
            missing.append(f"{ticker} ({name})")
            continue
        corp_code, corp_name = match
        rows.append({
            "ticker":    ticker,
            "corp_code": corp_code,
            "corp_name": corp_name,
        })

    print(f"[corp_codes] matched {len(rows)} / {len(tickers)}")
    if missing:
        print(f"[corp_codes] unmatched: {missing[:10]}")

    if rows:
        sb.table("kr_corp_codes").upsert(rows, on_conflict="ticker").execute()
        print("[corp_codes] upsert done")


if __name__ == "__main__":
    main()
