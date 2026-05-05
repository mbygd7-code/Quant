"""Register the Telegram webhook with the deployed Vercel URL — run once.

    VERCEL_DEPLOYMENT_URL=https://quant-signal.vercel.app \\
        python scripts/setup_telegram_webhook.py

Required env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, VERCEL_DEPLOYMENT_URL
"""
from __future__ import annotations

import os
import sys

import httpx


def main() -> int:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    base = os.environ.get("VERCEL_DEPLOYMENT_URL")
    secret = os.environ.get("TELEGRAM_WEBHOOK_SECRET")

    missing = [k for k, v in {
        "TELEGRAM_BOT_TOKEN": token,
        "VERCEL_DEPLOYMENT_URL": base,
        "TELEGRAM_WEBHOOK_SECRET": secret,
    }.items() if not v]
    if missing:
        print(f"Missing env: {', '.join(missing)}", file=sys.stderr)
        return 2

    url = base.rstrip("/") + "/api/telegram/webhook"
    response = httpx.post(
        f"https://api.telegram.org/bot{token}/setWebhook",
        json={
            "url": url,
            "secret_token": secret,
            "allowed_updates": ["message", "callback_query"],
        },
        timeout=15.0,
    )
    print(response.status_code, response.json())
    return 0 if response.status_code == 200 else 1


if __name__ == "__main__":
    sys.exit(main())
