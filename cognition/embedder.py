"""OpenAI text-embedding-3-small wrapper.

Used by:
  - cognition.sentiment   (news_items.embedding column)
  - cognition.rag.embedder (rag_chunks.embedding column, Prompt 05)

Embedding model is fixed at `text-embedding-3-small` (1536-dim) to match the
`vector(1536)` column type in the Supabase schema. Switching dimensions later
requires a migration.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from typing import TYPE_CHECKING

from cognition.utils.cache import Cache, make_cache

if TYPE_CHECKING:
    from openai import AsyncOpenAI

log = logging.getLogger("cognition.embedder")

EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536
CACHE_TTL_SECONDS = 7 * 24 * 3600     # 7 days
EMBEDDER_CONCURRENCY = 10             # OpenAI tier 1: ~3000 RPM, plenty of headroom


def _cache_key(text: str) -> str:
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
    return f"embed:{EMBEDDING_MODEL}:{h}"


class Embedder:
    """Async OpenAI embedder with caching."""

    def __init__(self, client: AsyncOpenAI | None = None, cache: Cache | None = None) -> None:
        self._client = client            # late-init so import doesn't require API key
        self._cache = cache or make_cache()
        self._sem = asyncio.Semaphore(EMBEDDER_CONCURRENCY)

    def _ensure_client(self) -> AsyncOpenAI:
        if self._client is None:
            from openai import AsyncOpenAI
            api_key = os.environ.get("OPENAI_API_KEY")
            if not api_key:
                raise RuntimeError("OPENAI_API_KEY not set")
            self._client = AsyncOpenAI(api_key=api_key)
        return self._client

    # ──────────────────────────────────────────────────────
    async def embed(self, text: str) -> list[float]:
        """Single text → 1536-dim vector. Returns cached value when available."""
        if not text:
            raise ValueError("Cannot embed empty text")

        cache_key = _cache_key(text)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached

        async with self._sem:
            client = self._ensure_client()
            response = await client.embeddings.create(model=EMBEDDING_MODEL, input=text)
        vector = response.data[0].embedding
        if len(vector) != EMBEDDING_DIM:
            raise RuntimeError(
                f"Unexpected embedding dim {len(vector)} (expected {EMBEDDING_DIM})"
            )
        self._cache.set(cache_key, vector, ttl_seconds=CACHE_TTL_SECONDS)
        return vector

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Parallel embedding. Order of result matches input."""
        return await asyncio.gather(*[self.embed(t) for t in texts])
