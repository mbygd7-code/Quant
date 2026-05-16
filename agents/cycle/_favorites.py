"""LNB favorites → Stage-2 analysis universe selector.

Reads the ``user_favorites`` table (migration 24) and returns the union
of tickers any user has favorited. The M4 cycle uses this to gate
expensive LLM analysis, while Stage-1 data collectors continue to
ingest the full admin watchlist.

When the union is empty (e.g. brand-new install, no user has favorited
anything yet), the caller should fall back to the full watchlist so the
system isn't silently inactive.
"""
from __future__ import annotations

from agents.db.repository import AgentRepository


def favorites_union(repo: AgentRepository) -> list[str]:
    """Return all distinct tickers across every user's favorites set.

    Returns an empty list when the table is missing (pre-migration) or
    has no rows — callers should handle that themselves rather than
    relying on this function to fall back.
    """
    try:
        # repo.client is the supabase-py admin client (service-role).
        rows = (
            repo.client.table("user_favorites")
            .select("ticker")
            .execute()
            .data
            or []
        )
    except Exception:
        # Migration 24 not applied yet OR table dropped — be silent so
        # the cycle worker falls through to the full watchlist instead
        # of crashing in production.
        return []

    seen: set[str] = set()
    out: list[str] = []
    for row in rows:
        t = (row.get("ticker") or "").upper()
        if not t or t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out
