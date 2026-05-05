"""QuantSignal FastAPI — Vercel Serverless entrypoint.

Lightweight only (Vercel 60s execution + 250MB build limit). Heavy work
(scikit-learn, pykrx, edgartools, finnhub) is delegated to GitHub Actions
via workflow_dispatch. See SKILL.md §11-2.

Routes:
  GET  /api/health                       — health check
  POST /api/telegram/webhook             — Telegram → bot updates
  GET  /api/admin/data-quality           — daily collection metrics
  GET  /api/admin/cost                   — LLM token / USD usage
  POST /api/backtest/start               — trigger workflow_dispatch (or mock)
  GET  /api/backtest/{job_id}/status     — poll backtest_jobs row
  GET  /api/backtest/{job_id}/result     — Storage signed URL + summary
  GET  /api/backtest/recent              — recent jobs
  GET  /api/notifications/preview-today  — DRY_RUN preview
  GET  /api/notifications/recent         — send history
  POST /api/notifications/send-now       — synchronous dispatch
  POST /api/users/invite                 — issue beta invite
  PATCH /api/users/{id}/role             — change role
  POST /api/users/{id}/disconnect-telegram
  DELETE /api/users/{id}                 — hard delete (cascade)
  GET  /api/users/list                   — admin list
  GET  /api/users/stats                  — by-role + recent counts
"""
from __future__ import annotations

from fastapi import FastAPI
from mangum import Mangum

app = FastAPI(title="QuantSignal API", version="0.2.0")

from apps.api.routes.admin import router as admin_router  # noqa: E402
from apps.api.routes.backtest import router as backtest_router  # noqa: E402
from apps.api.routes.notifications import router as notifications_router  # noqa: E402
from apps.api.routes.telegram_webhook import router as telegram_router  # noqa: E402
from apps.api.routes.users import router as users_router  # noqa: E402

app.include_router(telegram_router)
app.include_router(admin_router)
app.include_router(backtest_router)
app.include_router(notifications_router)
app.include_router(users_router)


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "quant-signal-api"}


# Vercel ASGI handler
handler = Mangum(app)
