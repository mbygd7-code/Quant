"""Supabase upsert helpers — chunked PostgREST writes + URL dedup for news.

Why chunking: PostgREST has a 1 MiB request size limit. KRX 50-stock daily
data is tiny (~10 KiB) but news payloads can balloon when text is large,
so we cap at 200 rows per request.
"""
from __future__ import annotations

import logging
from typing import Any

from db.supabase_client import get_admin_client

log = logging.getLogger("refinery.upsert")

DEFAULT_CHUNK_SIZE = 200


def chunked_upsert(
    table_name: str,
    rows: list[dict[str, Any]],
    *,
    on_conflict: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
) -> int:
    """Upsert rows into Supabase in chunks. Returns count of rows submitted.

    `on_conflict` is the comma-separated PK column list, e.g. 'date,ticker'.
    """
    if not rows:
        return 0
    sb = get_admin_client()
    written = 0
    for i in range(0, len(rows), chunk_size):
        chunk = rows[i : i + chunk_size]
        sb.table(table_name).upsert(chunk, on_conflict=on_conflict).execute()
        written += len(chunk)
        log.debug("[%s] upserted chunk %d-%d (%d rows)",
                  table_name, i, i + len(chunk), len(chunk))
    return written


def find_existing_news_urls(urls: list[str]) -> set[str]:
    """Query news_items for already-stored URLs to skip re-insertion."""
    if not urls:
        return set()
    sb = get_admin_client()
    # PostgREST `in.()` clause has length limits; chunk at 100.
    found: set[str] = set()
    for i in range(0, len(urls), 100):
        chunk = urls[i : i + 100]
        result = (
            sb.table("news_items")
              .select("url")
              .in_("url", chunk)
              .execute()
        )
        for row in result.data or []:
            if url := row.get("url"):
                found.add(url)
    return found


def known_tickers() -> set[str]:
    """Set of all `stocks.ticker` values — used to filter unknown symbols."""
    sb = get_admin_client()
    rows = sb.table("stocks").select("ticker").execute().data or []
    return {r["ticker"] for r in rows if r.get("ticker")}
