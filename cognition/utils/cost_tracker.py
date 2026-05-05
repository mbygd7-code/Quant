"""Daily LLM call counter — enforces CLAUDE.md §8 spend cap.

Counter is per (date, model) and persists in the cache (Redis when available,
in-memory otherwise). When the count would exceed `LLM_DAILY_CAP` we raise
`DailyCapExceeded` so the orchestrator can stop and alert the operator.
"""
from __future__ import annotations

import logging
import os
from datetime import date as Date

from cognition.utils.cache import Cache

log = logging.getLogger("cognition.cost")

DEFAULT_DAILY_CAP = 200


class DailyCapExceeded(RuntimeError):
    """Raised when an additional LLM call would exceed the configured daily cap."""


class CostTracker:
    def __init__(self, cache: Cache, model: str) -> None:
        self._cache = cache
        self._model = model
        self._cap = int(os.environ.get("LLM_DAILY_CAP", str(DEFAULT_DAILY_CAP)))

    def _key(self, on_date: Date) -> str:
        return f"llm:count:{on_date.isoformat()}:{self._model}"

    def current(self, on_date: Date) -> int:
        return int(self._cache.get(self._key(on_date)) or 0)

    def can_call(self, on_date: Date) -> bool:
        return self.current(on_date) < self._cap

    def increment(self, on_date: Date) -> int:
        n = self.current(on_date) + 1
        if n > self._cap:
            raise DailyCapExceeded(
                f"LLM daily cap reached for {self._model} on {on_date.isoformat()}: "
                f"{self._cap}/{self._cap}"
            )
        # 36h TTL — covers KST midnight rollover with safety margin.
        self._cache.set(self._key(on_date), n, ttl_seconds=36 * 3600)
        if n in (1, 50, 100, 150, 180):
            log.info("LLM call counter [%s/%s]: %d/%d",
                     self._model, on_date.isoformat(), n, self._cap)
        return n
