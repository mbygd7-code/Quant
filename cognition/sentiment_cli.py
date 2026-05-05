"""CLI: python -m cognition.sentiment_cli --date=2026-05-06

Processes all unscored news_items for the given date and updates the table.
Used standalone for ad-hoc backfill and called from orchestrator/pipeline.py
inside the cognition step.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo

from cognition.sentiment import SentimentEngine

KST = ZoneInfo("Asia/Seoul")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("cognition.sentiment_cli")


def _parse_date(arg: str) -> Date:
    if arg == "today":
        return datetime.now(tz=KST).date()
    return Date.fromisoformat(arg)


async def _main() -> int:
    parser = argparse.ArgumentParser(description="Score news_items for a given KST date")
    parser.add_argument("--date", default="today", help="YYYY-MM-DD or 'today'")
    args = parser.parse_args()

    target = _parse_date(args.date)
    engine = SentimentEngine()
    result = await engine.score_batch(target)
    log.info("Final: %s", result)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(_main()))
