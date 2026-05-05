"""Embed RAG chunks via OpenAI and upsert to Supabase rag_chunks table.

Idempotent — re-running with unchanged body re-uses the cached embedding.
Run on schema changes or new chunks:
    python -m cognition.rag.embedder
"""
from __future__ import annotations

import asyncio
import logging
import sys

from cognition.embedder import Embedder
from cognition.rag.loader import RawChunk, load_chunks
from db.supabase_client import get_admin_client

log = logging.getLogger("cognition.rag.embedder")


def _embed_input(chunk: RawChunk) -> str:
    """Compose text fed to the embedder. Topic + body + related tickers help
    semantic search find relevant chunks even when query phrasing varies."""
    return (
        f"{chunk.topic}\n"
        f"sectors: {', '.join(chunk.sectors)}\n"
        f"related: {', '.join(chunk.related_tickers)}\n\n"
        f"{chunk.body}"
    )


async def embed_and_upsert() -> int:
    """Read chunks from disk, embed, upsert. Returns count written."""
    chunks = load_chunks()
    if not chunks:
        log.warning("No chunks found in cognition/rag/chunks/.")
        return 0

    embedder = Embedder()
    sb = get_admin_client()

    rows: list[dict] = []
    for chunk in chunks:
        embedding = await embedder.embed(_embed_input(chunk))
        rows.append({
            "id": chunk.id,
            "topic": chunk.topic,
            "markets": chunk.markets,
            "sectors": chunk.sectors,
            "related_tickers": chunk.related_tickers,
            "trigger_conditions": chunk.trigger_conditions,
            "positive_signal": chunk.positive_signal,
            "risk_warning": chunk.risk_warning,
            "body": chunk.body,
            "embedding": embedding,
        })

    sb.table("rag_chunks").upsert(rows, on_conflict="id").execute()
    log.info("Upserted %d RAG chunks.", len(rows))
    return len(rows)


def main() -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s | %(levelname)s | %(message)s")
    asyncio.run(embed_and_upsert())
    return 0


if __name__ == "__main__":
    sys.exit(main())
