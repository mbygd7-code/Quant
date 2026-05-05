"""QuantSignal FastAPI — Vercel Serverless entrypoint.

Lightweight only (Vercel 60s execution + 250MB build limit). Heavy work
(scikit-learn, pykrx, edgartools, finnhub) is delegated to GitHub Actions
via workflow_dispatch. See SKILL.md §11-2.

Routes:
  GET  /api/health                  — health check
  POST /api/telegram/webhook        — Telegram → bot updates
  GET  /api/admin/data-quality      — daily collection metrics
  GET  /api/admin/cost              — LLM token / USD usage
  POST /api/backtest/start          — trigger GitHub workflow_dispatch
  GET  /api/backtest/{job_id}/status — poll backtest_jobs row
"""
from __future__ import annotations

import os
import uuid
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException
from mangum import Mangum
from pydantic import BaseModel, Field

app = FastAPI(title="QuantSignal API", version="0.1.0")

# Telegram webhook router — Prompt 08 wires real command handlers.
from apps.api.routes.telegram_webhook import router as telegram_router  # noqa: E402

app.include_router(telegram_router)


# ─────────────────────────────────────────────────────────────
# Health
# ─────────────────────────────────────────────────────────────
@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "quant-signal-api"}


# ─────────────────────────────────────────────────────────────
# Admin endpoints (Prompt 10 will flesh these out)
# ─────────────────────────────────────────────────────────────
@app.get("/api/admin/data-quality")
async def data_quality(date: str) -> dict[str, Any]:
    """Per-day collection success / refinery discard / LLM cost summary."""
    return {"date": date, "status": "not_implemented_until_prompt_10"}


@app.get("/api/admin/cost")
async def cost_report(date: str) -> dict[str, Any]:
    """LLM token usage + USD estimate for the day."""
    return {"date": date, "status": "not_implemented_until_prompt_10"}


# ─────────────────────────────────────────────────────────────
# Backtest trigger — GitHub workflow_dispatch
# ─────────────────────────────────────────────────────────────
class BacktestRequest(BaseModel):
    start_date: str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date:   str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    strategy:   str = Field(default="score_above_065")
    weight_config_id: str | None = None


@app.post("/api/backtest/start")
async def start_backtest(req: BacktestRequest) -> dict[str, str]:
    # NOTE: Prompt 09 will add `Depends(get_current_admin)` JWT verification.
    job_id = str(uuid.uuid4())

    repo = os.environ.get("GITHUB_REPO")
    pat  = os.environ.get("GITHUB_PAT")
    if not (repo and pat):
        raise HTTPException(500, "GITHUB_REPO / GITHUB_PAT not configured")

    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.post(
            f"https://api.github.com/repos/{repo}/actions/workflows/backtest.yml/dispatches",
            headers={
                "Authorization": f"Bearer {pat}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            json={
                "ref": "main",
                "inputs": {
                    "job_id":           job_id,
                    "start_date":       req.start_date,
                    "end_date":         req.end_date,
                    "strategy":         req.strategy,
                    "weight_config_id": req.weight_config_id or "",
                },
            },
        )
        if r.status_code >= 400:
            raise HTTPException(502, f"GitHub dispatch failed: {r.status_code} {r.text}")

    # Prompt 09 will also INSERT into backtest_jobs(status='queued') here.
    return {"job_id": job_id, "status": "queued"}


@app.get("/api/backtest/{job_id}/status")
async def backtest_status(job_id: str) -> dict[str, Any]:
    """Poll backtest_jobs row. Prompt 09 wires Supabase fetch."""
    return {"job_id": job_id, "status": "not_implemented_until_prompt_09"}


# Vercel ASGI handler
handler = Mangum(app)
