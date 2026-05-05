"""BaseCollector — shared retry + raw-backup machinery.

Each collector implements `fetch(on_date)` and returns a CollectorResult
with three things:
  - items: validated Pydantic models (refinery will further check these)
  - failed: per-symbol error records (logged, not raised)
  - raw_storage_path: where the un-validated raw payload was archived

Partial failure is OK (CLAUDE.md §B — "50종목 중 47종목 성공이면 진행").
The orchestrator decides if the success rate is acceptable.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date as Date
from typing import Any

import httpx
from pydantic import BaseModel
from tenacity import (
    before_sleep_log,
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from db.storage_client import upload_raw

log = logging.getLogger("collectors")


@dataclass
class CollectorResult:
    items: list[BaseModel] = field(default_factory=list)
    failed: list[dict[str, Any]] = field(default_factory=list)
    raw_storage_path: str | None = None

    @property
    def success_count(self) -> int:
        return len(self.items)

    @property
    def failure_count(self) -> int:
        return len(self.failed)

    @property
    def success_rate(self) -> float:
        total = self.success_count + self.failure_count
        return self.success_count / total if total else 0.0


class BaseCollector(ABC):
    """Subclasses set `source_name` (used as Storage filename stem)."""

    source_name: str

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if not getattr(cls, "source_name", None):
            raise TypeError(f"{cls.__name__} must set `source_name` class attribute")

    @abstractmethod
    def fetch(self, on_date: Date) -> CollectorResult:
        """Fetch all data for the given KST date.

        `on_date` is the pipeline's logical run-date in KST. Each collector
        translates this to its own market's most recent trading day.
        """
        raise NotImplementedError

    def _backup_raw(self, payload: Any, on_date: Date, suffix: str = "") -> str:
        """Archive the raw API payload before validation.

        Returns the Supabase Storage path (relative to bucket).
        Suffix lets sub-collectors disambiguate (e.g. 'finnhub_news' vs 'finnhub_quotes').
        """
        name = f"{self.source_name}{('_' + suffix) if suffix else ''}"
        return upload_raw(name, payload, on_date)

    @staticmethod
    def _retry():
        """Return a tenacity retry decorator for transient HTTP errors."""
        return retry(
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=1, min=1, max=10),
            retry=retry_if_exception_type((httpx.HTTPError, ConnectionError, TimeoutError)),
            before_sleep=before_sleep_log(log, logging.WARNING),
            reraise=True,
        )

    def _record_failure(
        self,
        result: CollectorResult,
        identifier: str,
        exc: Exception,
    ) -> None:
        """Log + append to result.failed without aborting."""
        log.warning("[%s] %s failed: %s: %s",
                    self.source_name, identifier, type(exc).__name__, exc)
        result.failed.append({
            "identifier": identifier,
            "error_class": type(exc).__name__,
            "message": str(exc),
        })
