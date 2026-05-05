"""Supabase Storage helpers — SKILL.md §10-4.

Three private buckets:
  - raw-api-backups/   : collectors raw JSON
  - backtest-reports/  : Recharts PNG/HTML
  - daily-reports/     : daily markdown reports
"""
from __future__ import annotations

import json
import os
from datetime import date as Date
from typing import Any

from db.supabase_client import get_admin_client

__all__ = [
    "BUCKET_RAW",
    "BUCKET_BACKTEST",
    "BUCKET_REPORTS",
    "upload_raw",
    "upload_backtest_artifact",
    "upload_daily_report",
    "signed_url",
]

BUCKET_RAW       = os.environ.get("SUPABASE_BUCKET_RAW",       "raw-api-backups")
BUCKET_BACKTEST  = os.environ.get("SUPABASE_BUCKET_BACKTEST",  "backtest-reports")
BUCKET_REPORTS   = os.environ.get("SUPABASE_BUCKET_REPORTS",   "daily-reports")


def _storage():
    return get_admin_client().storage


def upload_raw(source: str, payload: Any, on_date: Date) -> str:
    """Upload collector raw JSON to raw-api-backups/{YYYY-MM-DD}/{source}.json.

    Returns the storage path (relative to bucket).
    Overwrites if already exists.
    """
    path = f"{on_date.isoformat()}/{source}.json"
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    _storage().from_(BUCKET_RAW).upload(
        path=path,
        file=body,
        file_options={"content-type": "application/json", "upsert": "true"},
    )
    return path


def upload_backtest_artifact(
    job_id: str,
    filename: str,
    body: bytes,
    content_type: str = "image/png",
) -> str:
    """Upload backtest result (PNG / HTML) under backtest-reports/{job_id}/{filename}."""
    path = f"{job_id}/{filename}"
    _storage().from_(BUCKET_BACKTEST).upload(
        path=path,
        file=body,
        file_options={"content-type": content_type, "upsert": "true"},
    )
    return path


def upload_daily_report(on_date: Date, filename: str, markdown: str) -> str:
    """Upload daily markdown report under daily-reports/{YYYY-MM-DD}/{filename}."""
    path = f"{on_date.isoformat()}/{filename}"
    _storage().from_(BUCKET_REPORTS).upload(
        path=path,
        file=markdown.encode("utf-8"),
        file_options={"content-type": "text/markdown; charset=utf-8", "upsert": "true"},
    )
    return path


def signed_url(bucket: str, path: str, expires_in: int = 3600) -> str:
    """Generate a time-limited signed URL for a private bucket file."""
    result = _storage().from_(bucket).create_signed_url(path, expires_in)
    # supabase-py returns dict like {"signedURL": "..."} or {"signed_url": "..."} depending on version
    return result.get("signedURL") or result.get("signed_url") or result["signedUrl"]
