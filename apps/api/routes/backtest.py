"""Backtest job orchestration — workflow_dispatch + DB tracking.

Flow:
  1. POST /api/backtest/start    → INSERT backtest_jobs + dispatch GitHub workflow
  2. GET  /api/backtest/{id}/status → poll backtest_jobs row
  3. GET  /api/backtest/{id}/result → resolve Storage signed URL

Mock mode (when GITHUB_PAT missing or DEV_BYPASS_AUTH=true):
  - Skip workflow_dispatch
  - Mark job 'completed' with placeholder result so the UI flow can be
    exercised without burning Actions minutes.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import db.supabase_client as _sb_client

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


def _admin():
    """Indirection: re-resolve at call time so tests can monkeypatch."""
    return _sb_client.get_admin_client()


def _mock_mode() -> bool:
    if os.environ.get("DEV_BYPASS_AUTH") == "true":
        return True
    return not (os.environ.get("GITHUB_REPO") and os.environ.get("GITHUB_PAT"))


class BacktestRequest(BaseModel):
    start_date:       str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date:         str = Field(..., pattern=r"^\d{4}-\d{2}-\d{2}$")
    strategy:         str = Field(default="score_above_065")
    weight_config_id: str | None = None


@router.post("/start")
async def start_backtest(req: BacktestRequest) -> dict[str, str]:
    job_id = str(uuid.uuid4())
    sb = _admin()

    sb.table("backtest_jobs").insert({
        "id": job_id,
        "status": "queued",
        "params": req.model_dump(),
        "progress": 0,
    }).execute()

    if _mock_mode():
        # Simulate immediate completion with placeholder summary.
        sb.table("backtest_jobs").update({
            "status": "completed",
            "progress": 100,
            "result_url": None,
            "error": None,
            "started_at":   datetime.now(timezone.utc).isoformat(),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", job_id).execute()
        return {"job_id": job_id, "status": "completed", "mode": "mock"}

    repo = os.environ["GITHUB_REPO"]
    pat = os.environ["GITHUB_PAT"]
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
            sb.table("backtest_jobs").update({
                "status": "failed",
                "error": f"dispatch HTTP {r.status_code}: {r.text[:500]}",
                "completed_at": datetime.now(timezone.utc).isoformat(),
            }).eq("id", job_id).execute()
            raise HTTPException(502, f"GitHub dispatch failed: {r.status_code}")

    return {"job_id": job_id, "status": "queued", "mode": "live"}


@router.get("/{job_id}/status")
async def backtest_job_status(job_id: str) -> dict[str, Any]:
    sb = _admin()
    rows = (
        sb.table("backtest_jobs")
          .select("id, status, progress, result_url, error, run_url, "
                  "created_at, started_at, completed_at, params")
          .eq("id", job_id)
          .limit(1)
          .execute()
          .data
    )
    if not rows:
        raise HTTPException(404, f"job_id {job_id} not found")
    return rows[0]


@router.get("/{job_id}/result")
async def backtest_result(job_id: str) -> dict[str, Any]:
    """Return summary stats + signed URL for downloadable artifact."""
    sb = _admin()
    rows = (
        sb.table("backtest_jobs")
          .select("*")
          .eq("id", job_id)
          .limit(1)
          .execute()
          .data
    )
    if not rows:
        raise HTTPException(404, f"job_id {job_id} not found")
    job = rows[0]
    if job.get("status") != "completed":
        raise HTTPException(409, f"job not completed (status={job.get('status')})")

    # Aggregate from backtest_results table
    params = job.get("params") or {}
    strategy = params.get("strategy", "")
    res_rows = (
        sb.table("backtest_results")
          .select("date, ticker, signal, actual_return, hit, entry_price, exit_price")
          .eq("strategy_id", strategy)
          .gte("date", params.get("start_date", "1900-01-01"))
          .lte("date", params.get("end_date", "9999-12-31"))
          .order("date", desc=False)
          .execute()
          .data
    ) or []

    n_trades = len(res_rows)
    n_hits = sum(1 for r in res_rows if r.get("hit"))
    win_rate = (n_hits / n_trades) if n_trades else None
    cum_return = sum((r.get("actual_return") or 0.0) for r in res_rows)

    # signed URL (24h) — falls back to None if no artifact
    signed_url = None
    if job.get("result_url"):
        # result_url stored as 'bucket/path' or full URL
        try:
            path = job["result_url"]
            if "/" in path and not path.startswith("http"):
                bucket, key = path.split("/", 1)
                signed = sb.storage.from_(bucket).create_signed_url(key, 86400)
                signed_url = signed.get("signedURL") or signed.get("signed_url")
            else:
                signed_url = path
        except Exception:
            signed_url = None

    return {
        "job":       job,
        "summary":   {
            "n_trades":   n_trades,
            "n_hits":     n_hits,
            "win_rate":   win_rate,
            "cum_return": cum_return,
        },
        "trades":     res_rows,
        "signed_url": signed_url,
    }


@router.get("/recent")
async def recent_jobs(limit: int = 10) -> list[dict[str, Any]]:
    sb = _admin()
    rows = (
        sb.table("backtest_jobs")
          .select("id, status, progress, params, run_url, created_at, completed_at")
          .order("created_at", desc=True)
          .limit(min(limit, 50))
          .execute()
          .data
    ) or []
    return rows
