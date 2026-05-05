"""Local-development polling entrypoint.

    python -m notifier.bot_runner

In production we run via Vercel webhook (apps/api/routes/telegram_webhook).
Polling is for interactive local testing only.
"""
from __future__ import annotations

import logging
import os
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("notifier.bot_runner")


def main() -> int:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        log.error("TELEGRAM_BOT_TOKEN env var is required")
        return 1

    from telegram.ext import (
        Application,
        CallbackQueryHandler,
        CommandHandler,
    )

    from notifier import telegram_handlers as h

    application = Application.builder().token(token).build()
    application.add_handler(CommandHandler("start", h.cmd_start))
    application.add_handler(CommandHandler("link", h.cmd_link))
    application.add_handler(CommandHandler("today", h.cmd_today))
    application.add_handler(CommandHandler("stock", h.cmd_stock))
    application.add_handler(CommandHandler("sector", h.cmd_sector))
    application.add_handler(CommandHandler("top", h.cmd_top))
    application.add_handler(CommandHandler("risk", h.cmd_risk))
    application.add_handler(CommandHandler("feedback", h.cmd_feedback))
    application.add_handler(CommandHandler("feedback_note", h.cmd_feedback_note))
    application.add_handler(CommandHandler("help", h.cmd_help))
    application.add_handler(CallbackQueryHandler(h.callback_handler))

    log.info("Starting Telegram bot in polling mode (Ctrl+C to stop)")
    application.run_polling()
    return 0


if __name__ == "__main__":
    sys.exit(main())
