"""Supabase client factories. Service-role for backend, anon for client-facing.

SKILL.md §10-1. Cached singletons — `get_admin_client()` is RLS-bypassing and
must NEVER be exposed to user-facing code paths (CLAUDE.md E).
"""
from __future__ import annotations

import os
from functools import lru_cache

from supabase import Client, create_client

__all__ = [
    "get_admin_client",
    "get_anon_client",
    "verify_connection",
]


def _require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise RuntimeError(
            f"Environment variable {key!r} is required. "
            f"Set it in your .env (local) or Vercel/GitHub Secrets (deployed)."
        )
    return val


@lru_cache(maxsize=1)
def get_admin_client() -> Client:
    """Service-Role client — bypasses RLS. Backend workers ONLY.

    Never import this in code that handles client requests directly
    (e.g. HTTP responses bound to user identity). Use it from:
      - GitHub Actions runners (collectors, refinery, cognition, signal)
      - apps/api server-side handlers that have already authenticated the caller
    """
    return create_client(
        _require_env("SUPABASE_URL"),
        _require_env("SUPABASE_SERVICE_ROLE_KEY"),
    )


@lru_cache(maxsize=1)
def get_anon_client() -> Client:
    """Anon client — RLS applies. Safe for code paths bound to a user JWT."""
    return create_client(
        _require_env("SUPABASE_URL"),
        _require_env("SUPABASE_ANON_KEY"),
    )


def verify_connection() -> None:
    """Health check — call at pipeline startup. Raises SystemExit on failure."""
    try:
        sb = get_admin_client()
        sb.table("stocks").select("id").limit(1).execute()
    except Exception as exc:
        raise SystemExit(f"Supabase connection failed: {exc}") from exc


def fetch_all(query, page_size: int = 1000) -> list[dict]:
    """Paginate a PostgREST SELECT past Supabase's 1000-row default cap.

    PostgREST returns at most 1000 rows per request regardless of how many
    match. Callers that need the full result set (e.g. multi-year price
    history across 50 tickers) must page with .range(). This helper loops
    .range(offset, offset+page_size-1) until a short page signals the end.

    Pass a *builder* with all filters/ordering applied but WITHOUT .execute():
        rows = fetch_all(
            sb.table("korea_market").select("date,ticker,change_rate")
              .gte("date", since).order("date")
        )

    NOTE: an explicit .order() is strongly recommended — without a stable
    sort, range windows can overlap or skip rows between requests.
    """
    out: list[dict] = []
    offset = 0
    while True:
        page = query.range(offset, offset + page_size - 1).execute().data or []
        out.extend(page)
        if len(page) < page_size:
            break
        offset += page_size
    return out
