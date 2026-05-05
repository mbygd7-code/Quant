"""Vercel webhook for Telegram updates.

Mirror of notifier.bot_runner: same handlers wired into a python-telegram-bot
Application, but driven by HTTP POST instead of polling.
"""
from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

from fastapi import APIRouter, Header, HTTPException, Request

if TYPE_CHECKING:
    from telegram.ext import Application

log = logging.getLogger("apps.api.telegram_webhook")

router = APIRouter()
_application = None


async def _get_application() -> Application:
    """Lazy-built singleton. Survives across warm Vercel invocations."""
    global _application
    if _application is not None:
        return _application

    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise RuntimeError("TELEGRAM_BOT_TOKEN not configured")

    from telegram.ext import (
        Application,
        CallbackQueryHandler,
        CommandHandler,
    )

    from notifier import telegram_handlers as h

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", h.cmd_start))
    app.add_handler(CommandHandler("link", h.cmd_link))
    app.add_handler(CommandHandler("today", h.cmd_today))
    app.add_handler(CommandHandler("stock", h.cmd_stock))
    app.add_handler(CommandHandler("sector", h.cmd_sector))
    app.add_handler(CommandHandler("top", h.cmd_top))
    app.add_handler(CommandHandler("risk", h.cmd_risk))
    app.add_handler(CommandHandler("feedback", h.cmd_feedback))
    app.add_handler(CommandHandler("help", h.cmd_help))
    app.add_handler(CallbackQueryHandler(h.callback_handler))

    await app.initialize()
    _application = app
    return app


@router.post("/api/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict:
    expected = os.environ.get("TELEGRAM_WEBHOOK_SECRET")
    if not expected:
        raise HTTPException(500, "TELEGRAM_WEBHOOK_SECRET not configured")
    if x_telegram_bot_api_secret_token != expected:
        raise HTTPException(403, "Invalid webhook secret")

    from telegram import Update
    body = await request.json()
    application = await _get_application()
    update = Update.de_json(body, application.bot)
    await application.process_update(update)
    return {"ok": True, "update_id": body.get("update_id")}
