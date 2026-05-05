"""TTL cache — Redis when available, in-memory fallback otherwise.

The `Cache` interface returns JSON-serializable dicts/lists. CLAUDE.md §C
mandates that identical (date, ticker) sentiment scores must be cached so
we don't re-spend tokens on the same article.
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

log = logging.getLogger("cognition.cache")


class Cache:
    """Backend-agnostic interface."""

    def get(self, key: str) -> Any | None:
        raise NotImplementedError

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        raise NotImplementedError


class InMemoryCache(Cache):
    """Process-local cache. Used in tests and when REDIS_URL is unset."""

    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        entry = self._store.get(key)
        if not entry:
            return None
        expires_at, value = entry
        if expires_at < time.time():
            del self._store[key]
            return None
        return value

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        self._store[key] = (time.time() + ttl_seconds, value)


class RedisCache(Cache):
    """Redis-backed (Upstash recommended). Requires `REDIS_URL` env var."""

    def __init__(self, url: str) -> None:
        import redis  # lazy import — only when actually selected
        self._client = redis.Redis.from_url(url, decode_responses=True)

    def get(self, key: str) -> Any | None:
        raw = self._client.get(key)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            log.warning("Redis cache value at %r is not JSON; ignoring", key)
            return None

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        self._client.setex(key, ttl_seconds, json.dumps(value, default=str))


def make_cache() -> Cache:
    """Pick a backend based on env. REDIS_URL set → Redis, else InMemory."""
    url = os.environ.get("REDIS_URL")
    if not url:
        log.info("REDIS_URL unset — using in-memory cache (process-local).")
        return InMemoryCache()
    try:
        cache = RedisCache(url)
        # Probe — if Redis is unreachable, fall back to in-memory rather than crash.
        cache._client.ping()
        log.info("Cache backend: Redis at %s", url.split("@")[-1])
        return cache
    except Exception as exc:
        log.warning("Redis unreachable (%s); falling back to in-memory cache.", exc)
        return InMemoryCache()
