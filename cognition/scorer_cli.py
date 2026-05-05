"""CLI: python -m cognition.scorer_cli --date=2026-05-06

Scores all 50 watchlist tickers for the given KST date and upserts to
ai_scores. Called by orchestrator/pipeline.py inside step 4.
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo

from cognition.scorer import StockScorer, upsert_score
from db.supabase_client import get_admin_client

KST = ZoneInfo("Asia/Seoul")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("cognition.scorer_cli")


def _parse_date(arg: str) -> Date:
    if arg == "today":
        return datetime.now(tz=KST).date()
    return Date.fromisoformat(arg)


def main() -> int:
    parser = argparse.ArgumentParser(description="Score watchlist tickers")
    parser.add_argument("--date", default="today", help="YYYY-MM-DD or 'today'")
    args = parser.parse_args()
    target = _parse_date(args.date)

    sb = get_admin_client()
    tickers = [
        r["ticker"]
        for r in (sb.table("stocks").select("ticker")
                  .eq("is_watchlist", True).execute().data or [])
    ]
    log.info("Scoring %d watchlist tickers for %s", len(tickers), target)

    scorer = StockScorer()
    success, failed = 0, 0
    for ticker in tickers:
        try:
            score = scorer.score(ticker, target)
            upsert_score(score)
            success += 1
        except Exception as exc:
            log.warning("ticker=%s failed: %s", ticker, exc)
            failed += 1

    log.info("Done. success=%d failed=%d", success, failed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
