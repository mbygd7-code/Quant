"""Semantic search over rag_chunks via the match_rag_chunks RPC.

This is the runtime side: callers (cognition.scorer, signal/report) embed a
query string, ask for the top-K most similar chunks (optionally filtered by
ticker/sector), and use them as evidence in the final LLM-generated report.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from cognition.embedder import Embedder
from db.supabase_client import get_admin_client

log = logging.getLogger("cognition.rag.retriever")


@dataclass
class RetrievedChunk:
    id: str
    topic: str
    body: str
    related_tickers: list[str]
    sectors: list[str]
    similarity: float


async def retrieve(
    query: str,
    *,
    ticker: str | None = None,
    sector: str | None = None,
    top_k: int = 5,
    embedder: Embedder | None = None,
) -> list[RetrievedChunk]:
    """Embed `query` and return top_k nearest rag_chunks (cosine similarity).

    If `ticker` is given, only chunks whose `related_tickers` contains it
    are considered. Similarly for `sector`.
    """
    embedder = embedder or Embedder()
    embedding = await embedder.embed(query)

    sb = get_admin_client()
    params: dict = {
        "query_embedding": embedding,
        "match_count": top_k,
        "filter_tickers": [ticker] if ticker else None,
        "filter_sectors": [sector] if sector else None,
    }
    response = sb.rpc("match_rag_chunks", params).execute()
    rows = response.data or []
    return [
        RetrievedChunk(
            id=row["id"],
            topic=row["topic"],
            body=row["body"],
            related_tickers=row.get("related_tickers") or [],
            sectors=row.get("sectors") or [],
            similarity=float(row["similarity"]),
        )
        for row in rows
    ]
