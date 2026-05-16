"""Backfill 30 days of KR news per watchlist ticker.

One-off — run after migration 24 + before the first cron with E enabled.
NAVER's per-ticker `news/related` endpoint returns the last ~20 articles
by default; for backfill we set page_size higher and paginate naturally
by the natural URL-conflict dedup in upsert_news_rows.

Usage:
  python -m scripts.backfill_kr_news                 # all watchlist
  python -m scripts.backfill_kr_news --tickers 005930,000660
  python -m scripts.backfill_kr_news --page-size 50  # deeper history
"""
from __future__ import annotations

import argparse
import time

from collectors.kr_news import collect_and_persist
from db.supabase_client import get_admin_client


def _watchlist_tickers(sb) -> list[str]:  # noqa: ANN001
    rows = (
        sb.table("stocks")
        .select("ticker")
        .eq("is_watchlist", True)
        .execute()
        .data
        or []
    )
    return sorted([r["ticker"] for r in rows])


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--tickers", default=None, help="comma-separated KR tickers")
    p.add_argument("--page-size", type=int, default=50)
    p.add_argument("--pace", type=float, default=1.0)
    args = p.parse_args()

    sb = get_admin_client()
    if args.tickers:
        tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = _watchlist_tickers(sb)

    if not tickers:
        print("[backfill_kr_news] no tickers")
        return

    print(f"[backfill_kr_news] {len(tickers)} tickers, page_size={args.page_size}")
    start = time.time()
    summary = collect_and_persist(
        sb, tickers, page_size=args.page_size, pace_seconds=args.pace
    )
    elapsed = time.time() - start
    print(
        f"[backfill_kr_news] done · {summary['tickers']} tickers "
        f"· {summary['fetched']} fetched · {summary['inserted']} inserted "
        f"· {summary['duplicate_skipped']} dup · {elapsed:.1f}s"
    )


if __name__ == "__main__":
    main()
