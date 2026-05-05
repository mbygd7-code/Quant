"""NotificationDispatcher — fan-out across channels with retry + audit log.

Pipeline contract:
  orchestrator.pipeline (step 5) calls dispatcher.dispatch(date)
  dispatcher selects channels from NOTIFY_CHANNELS env, instantiates each,
  and records every send attempt to the notifications table.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import date as Date
from typing import TYPE_CHECKING

from db.supabase_client import get_admin_client
from notifier.telegram import TelegramNotifier
from notifier.telegram_handlers import _gather_preview

if TYPE_CHECKING:
    pass

log = logging.getLogger("notifier.dispatcher")


def _channels() -> list[str]:
    return [c.strip() for c in os.environ.get("NOTIFY_CHANNELS", "telegram").split(",") if c.strip()]


def _chat_ids() -> list[str]:
    raw = os.environ.get("TELEGRAM_CHAT_IDS", "")
    explicit = [c.strip() for c in raw.split(",") if c.strip()]
    if explicit:
        return explicit
    # Fallback: just the operator. Beta users come from profiles table.
    sb = get_admin_client()
    rows = (
        sb.table("profiles")
          .select("telegram_chat_id")
          .not_.is_("telegram_chat_id", "null")
          .eq("notification_enabled", True)
          .execute()
          .data
    ) or []
    chat_ids = [r["telegram_chat_id"] for r in rows if r.get("telegram_chat_id")]
    admin = os.environ.get("TELEGRAM_ADMIN_CHAT_ID")
    if admin and admin not in chat_ids:
        chat_ids.append(admin)
    return chat_ids


class NotificationDispatcher:
    def __init__(self) -> None:
        self._notifiers: list[TelegramNotifier] = []
        for ch in _channels():
            if ch == "telegram":
                token = os.environ.get("TELEGRAM_BOT_TOKEN")
                if not token:
                    log.warning("TELEGRAM_BOT_TOKEN unset — telegram channel disabled")
                    continue
                self._notifiers.append(TelegramNotifier(token, _chat_ids()))
            elif ch == "kakao":
                from notifier.kakao import KakaoNotifier
                self._notifiers.append(KakaoNotifier())
            else:
                log.warning("Unknown notify channel: %s", ch)

    async def dispatch(self, on_date: Date) -> dict:
        if not self._notifiers:
            log.warning("No active notifiers — dispatch skipped")
            return {"sent": 0, "failed": 0}

        sb = get_admin_client()
        market, sector_counts, top5 = _gather_preview(sb, on_date)

        sent, failed = 0, 0
        for notifier in self._notifiers:
            for attempt in range(3):
                try:
                    await notifier.send_preview(on_date, market, sector_counts, top5)
                    sent += len(notifier.chat_ids)
                    self._log_status(on_date, "telegram", "sent", payload={"chat_ids": notifier.chat_ids})
                    break
                except Exception as exc:
                    log.warning("Send attempt %d failed: %s", attempt + 1, exc)
                    if attempt == 2:
                        failed += len(notifier.chat_ids)
                        self._log_status(on_date, "telegram", "failed",
                                          payload={"chat_ids": notifier.chat_ids},
                                          error=str(exc))
                        await self._alert_admin(notifier, str(exc))
                    else:
                        await asyncio.sleep(2 ** attempt)
        return {"sent": sent, "failed": failed}

    async def _alert_admin(self, notifier: TelegramNotifier, msg: str) -> None:
        try:
            await notifier.send_admin_alert(
                f"Daily preview send failed: {msg[:200]}", level="error",
            )
        except Exception as exc:
            log.error("admin alert also failed: %s", exc)

    def _log_status(
        self, on_date: Date, channel: str, status: str,
        *, payload: dict, error: str | None = None,
    ) -> None:
        try:
            sb = get_admin_client()
            sb.table("notifications").insert({
                "date": on_date.isoformat(),
                "channel": channel,
                "recipient": ",".join(payload.get("chat_ids") or []),
                "payload": payload,
                "status": status,
                "error": error,
            }).execute()
        except Exception as exc:
            log.warning("notifications log insert failed: %s", exc)
