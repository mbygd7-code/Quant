"""Notifications admin endpoints — DRY_RUN preview + manual trigger."""
from __future__ import annotations

from datetime import date as Date
from typing import Any

from fastapi import APIRouter, HTTPException

import db.supabase_client as _sb_client

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


def _admin():
    return _sb_client.get_admin_client()


@router.get("/preview-today")
async def preview_today() -> dict[str, Any]:
    """Build the same preview payload the daily dispatcher would send."""
    from notifier.telegram_handlers import _gather_preview

    sb = _admin()
    target = Date.today()

    try:
        market, sector_counts, top5 = _gather_preview(sb, target)
    except Exception as exc:
        raise HTTPException(500, f"preview gather failed: {exc}")

    return {
        "date":           target.isoformat(),
        "market":         market,
        "sector_counts":  sector_counts,
        "top5":           top5,
    }


@router.get("/recent")
async def recent_notifications(limit: int = 50) -> list[dict[str, Any]]:
    sb = _admin()
    rows = (
        sb.table("notifications")
          .select("id, date, channel, recipient, status, error, sent_at")
          .order("sent_at", desc=True)
          .limit(min(limit, 200))
          .execute()
          .data
    ) or []
    return rows


@router.post("/send-now")
async def send_now() -> dict[str, Any]:
    """Synchronously dispatch today's preview. Admin-triggered."""
    from notifier.dispatcher import NotificationDispatcher

    target = Date.today()
    dispatcher = NotificationDispatcher()
    res = await dispatcher.dispatch(target)
    return {"date": target.isoformat(), **res}
