"""Admin endpoints — read-only summaries of daily pipeline health.

Lightweight DB queries only (Vercel 60s + 250MB limit). Heavy work (backtest
runs, etc.) is delegated to GitHub workflow_dispatch elsewhere in this file.
"""
from __future__ import annotations

import os
from datetime import date as Date
from datetime import timedelta

from fastapi import APIRouter, HTTPException, Query

router = APIRouter(prefix="/api/admin")


def _sb():
    from db.supabase_client import get_admin_client
    return get_admin_client()


def _parse_date(s: str | None) -> Date:
    if not s:
        return Date.today()
    try:
        return Date.fromisoformat(s)
    except ValueError as exc:
        raise HTTPException(400, f"Invalid date: {s!r}") from exc


# ──────────────────────────────────────────────────────────
# Data quality
# ──────────────────────────────────────────────────────────
@router.get("/data-quality")
async def data_quality(date: str | None = Query(default=None)) -> dict:
    """Per-date pipeline metrics: collect/refine/scoring counts + notify status."""
    on_date = _parse_date(date)
    sb = _sb()
    iso = on_date.isoformat()

    korea_count = len(
        sb.table("korea_market").select("ticker").eq("date", iso).execute().data or []
    )
    global_count = len(
        sb.table("global_market").select("symbol").eq("date", iso).execute().data or []
    )
    news_count = len(
        sb.table("news_items").select("id").eq("date", iso).execute().data or []
    )
    scored_count = len(
        sb.table("ai_scores").select("ticker").eq("date", iso).execute().data or []
    )
    sentiment_done = len(
        sb.table("news_items").select("id").eq("date", iso)
          .not_.is_("sentiment_score", "null").execute().data or []
    )
    sentiment_pct = (sentiment_done / news_count) if news_count else 0.0

    notif_rows = sb.table("notifications").select("status, channel")\
        .eq("date", iso).execute().data or []
    notif_summary: dict[str, dict[str, int]] = {}
    for row in notif_rows:
        ch = row.get("channel", "?")
        st = row.get("status", "?")
        notif_summary.setdefault(ch, {})[st] = notif_summary[ch].get(st, 0) + 1

    return {
        "date": iso,
        "collected": {
            "korea_market_rows": korea_count,
            "global_market_rows": global_count,
            "news_items": news_count,
        },
        "scored": {
            "ai_scores_rows": scored_count,
            "sentiment_completion_pct": round(sentiment_pct * 100, 1),
        },
        "notifications": notif_summary,
    }


# ──────────────────────────────────────────────────────────
# Cost — LLM call counter
# ──────────────────────────────────────────────────────────
@router.get("/cost")
async def cost_report(date: str | None = Query(default=None)) -> dict:
    """LLM call counts (from cache) + rough USD estimate.

    Costs are estimated from token-budget assumptions in CLAUDE.md §8:
      sentiment call ~ 1.5k input + 200 output → ~$0.0075 (Sonnet 4.7)
      report call    ~ 5k   input + 500 output → ~$0.0225
    """
    on_date = _parse_date(date)
    from cognition.utils.cache import make_cache
    cache = make_cache()

    sentiment_model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    sentiment_calls = int(cache.get(f"llm:count:{on_date.isoformat()}:{sentiment_model}") or 0)

    # Report uses the same model + counter currently — split tracking deferred.
    report_calls = sentiment_calls            # placeholder until per-purpose counter

    sentiment_cost = sentiment_calls * 0.0075
    report_cost = report_calls * 0.0225

    return {
        "date": on_date.isoformat(),
        "model": sentiment_model,
        "sentiment_calls": sentiment_calls,
        "estimated_usd": round(sentiment_cost + report_cost, 4),
        "cap": int(os.environ.get("LLM_DAILY_CAP", "200")),
    }


# ──────────────────────────────────────────────────────────
# Notifications log preview
# ──────────────────────────────────────────────────────────
@router.get("/notifications")
async def notifications_log(
    date: str | None = Query(default=None),
    days: int = Query(default=7, ge=1, le=30),
) -> dict:
    """Recent notification send log."""
    on_date = _parse_date(date)
    since = on_date - timedelta(days=days)
    sb = _sb()
    rows = (
        sb.table("notifications")
          .select("date, channel, recipient, status, error, sent_at")
          .gte("date", since.isoformat())
          .lte("date", on_date.isoformat())
          .order("sent_at", desc=True)
          .limit(200)
          .execute()
          .data
    ) or []
    return {
        "date_range": {"from": since.isoformat(), "to": on_date.isoformat()},
        "rows": rows,
    }
