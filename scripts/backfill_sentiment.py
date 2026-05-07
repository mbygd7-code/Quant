"""Backfill sentiment_score on news_items rows that don't have it yet.

Uses cognition.sentiment (Claude API) with the LLM cache so re-runs are
free for already-scored items.

Cost: ~$0.0075 per news item (claude-sonnet-4-6, 1.5k input + 200 output
per CLAUDE.md §8). For 1,850 unrated items ≈ $14. Cache hits reduce this
on re-run.

Usage:
  python -m scripts.backfill_sentiment --limit 200          # incremental
  python -m scripts.backfill_sentiment --limit 0            # all unrated
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from db.supabase_client import get_admin_client


async def main(limit: int) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[backfill_sentiment] ANTHROPIC_API_KEY not set -- aborting")
        sys.exit(1)

    from cognition.sentiment import score_news_sentiment

    sb = get_admin_client()
    q = (
        sb.table("news_items")
          .select("id, title, body, related_symbols, date")
          .is_("sentiment_score", "null")
          .order("date", desc=True)
    )
    if limit > 0:
        q = q.limit(limit)
    rows = q.execute().data or []
    print(f"[backfill_sentiment] {len(rows)} items to process")
    if not rows:
        return

    sem = asyncio.Semaphore(int(os.environ.get("SENTIMENT_CONCURRENCY", "3")))
    completed = 0
    failed = 0

    async def process(row: dict) -> None:
        nonlocal completed, failed
        async with sem:
            try:
                result = await score_news_sentiment(
                    title=row["title"],
                    body=row.get("body"),
                    related_symbols=row.get("related_symbols") or [],
                )
                sb.table("news_items").update({
                    "sentiment_score": float(result.score),
                    "sentiment_label": result.label,
                }).eq("id", row["id"]).execute()
                completed += 1
                if completed % 25 == 0:
                    print(f"  ... {completed} done")
            except Exception as exc:
                failed += 1
                if failed <= 5:
                    print(f"  failed {row['id']}: {exc}")

    await asyncio.gather(*(process(r) for r in rows))
    print(f"\n[backfill_sentiment] done: completed={completed} failed={failed}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=200)
    args = ap.parse_args()
    asyncio.run(main(args.limit))
