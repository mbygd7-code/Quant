"""Backfill sentiment_score on news_items rows that don't have it yet.

Uses cognition.sentiment.SentimentEngine (Claude API) with cache + cost
cap. Re-runs are free for already-scored items.

Cost guidance (CLAUDE.md §8):
  - claude-sonnet-4-6: ~$0.0075 per item   (1.5k in + 200 out)
  - claude-haiku-4-5:  ~$0.002 per item   (74% cheaper)

Defaults to a 3-day window because the scorer's _news factor only
looks at the last 3 days; older sentiment data isn't used by any factor.

Usage:
  python -m scripts.backfill_sentiment                              # default: 3-day window, haiku
  python -m scripts.backfill_sentiment --days 0                     # all dates
  python -m scripts.backfill_sentiment --model claude-sonnet-4-6    # override model
  python -m scripts.backfill_sentiment --limit 200                  # cap items processed
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client


async def main(days: int, limit: int, model: str) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[backfill_sentiment] ANTHROPIC_API_KEY not set -- aborting")
        sys.exit(1)

    from cognition.sentiment import SentimentEngine

    sb = get_admin_client()
    q = (
        sb.table("news_items")
          .select("id, title, body, related_symbols, date")
          .is_("sentiment_score", "null")
          .order("date", desc=True)
    )
    if days > 0:
        since = (Date.today() - timedelta(days=days)).isoformat()
        q = q.gte("date", since)
        print(f"[backfill_sentiment] window: last {days} days (since {since})")
    if limit > 0:
        q = q.limit(limit)
    rows = q.execute().data or []
    print(f"[backfill_sentiment] {len(rows)} items to process · model={model}")
    if not rows:
        return

    engine = SentimentEngine(model=model)
    completed = 0
    failed = 0
    capped = 0

    async def process(row: dict) -> None:
        nonlocal completed, failed, capped
        try:
            on_date = Date.fromisoformat(row["date"])
            result = await engine.score_one(
                on_date=on_date,
                title=row.get("title") or "",
                body=row.get("body"),
                related_symbols=row.get("related_symbols") or [],
            )
            sb.table("news_items").update({
                "sentiment_score": float(result.sentiment_score),
                "sentiment_label": result.sentiment_label,
            }).eq("id", row["id"]).execute()
            completed += 1
            if completed % 25 == 0:
                print(f"  ... {completed} done")
        except Exception as exc:
            cls_name = type(exc).__name__
            if cls_name == "DailyCapExceeded":
                capped += 1
                return
            failed += 1
            if failed <= 5:
                print(f"  failed id={row.get('id')}: {exc}")

    # SentimentEngine has its own internal semaphore — gather all at once.
    await asyncio.gather(*(process(r) for r in rows))
    print(f"\n[backfill_sentiment] done: completed={completed} "
          f"failed={failed} capped={capped}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days",  type=int, default=3,
                    help="lookback in days (0 = all dates)")
    ap.add_argument("--limit", type=int, default=0,
                    help="max items to process (0 = no cap)")
    ap.add_argument("--model", type=str, default="claude-haiku-4-5",
                    help="Anthropic model (default: claude-haiku-4-5)")
    args = ap.parse_args()
    asyncio.run(main(args.days, args.limit, args.model))
