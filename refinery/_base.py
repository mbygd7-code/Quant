"""BaseRefiner — semantic validation + Supabase upsert + discard archival.

Pipeline contract:
  collectors  → CollectorResult(items=[Pydantic model], failed=[...])
  refinery    → RefineryReport(accepted, discarded, duplicates, ...) + DB rows in place
  cognition   → reads DB rows for downstream LLM scoring

Each refiner subclass:
  - declares `source` (matches collector source_name) and `table_name`
  - implements `_validate_row(row)` → (is_ok, reason or None)
  - implements `_to_db_row(item)` → dict shaped for the table

The base class handles aggregation, discard archival to Storage, and the
upsert call. Discard rate ~14.45% per CLAUDE.md §B is *expected* (raw data
is noisy); we log WARN only outside the [10%, 20%] band.
"""
from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date as Date
from typing import Any

from pydantic import BaseModel

from db.storage_client import upload_raw

log = logging.getLogger("refinery")

# CLAUDE.md §B — empirical raw-data error rate. Outside this window we WARN.
EXPECTED_DISCARD_LOW = 0.10
EXPECTED_DISCARD_HIGH = 0.20


@dataclass
class RefineryReport:
    source: str
    on_date: Date
    accepted: int = 0
    discarded: int = 0
    duplicates: int = 0
    discard_reasons: dict[str, int] = field(default_factory=dict)
    storage_path: str | None = None

    @property
    def total(self) -> int:
        return self.accepted + self.discarded

    @property
    def discard_rate(self) -> float:
        return self.discarded / self.total if self.total else 0.0

    @property
    def is_within_expected_range(self) -> bool:
        if self.total == 0:
            return True   # nothing collected — refinery has nothing to say
        return EXPECTED_DISCARD_LOW <= self.discard_rate <= EXPECTED_DISCARD_HIGH

    def add_discard(self, reason: str) -> None:
        self.discarded += 1
        self.discard_reasons[reason] = self.discard_reasons.get(reason, 0) + 1

    def add_accepted(self) -> None:
        self.accepted += 1

    def add_duplicate(self) -> None:
        self.duplicates += 1


class BaseRefiner(ABC):
    """Subclasses set `source` and `table_name`; implement validation + row shaping."""

    source: str
    table_name: str

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        for attr in ("source", "table_name"):
            if not getattr(cls, attr, None):
                raise TypeError(f"{cls.__name__} must set `{attr}` class attribute")

    # ──────────────────────────────────────────────────────
    # Public — orchestrator entrypoint
    # ──────────────────────────────────────────────────────
    def refine_and_upsert(
        self,
        items: list[BaseModel],
        on_date: Date,
    ) -> RefineryReport:
        report = RefineryReport(source=self.source, on_date=on_date)
        accepted_rows: list[dict[str, Any]] = []
        discarded_records: list[dict[str, Any]] = []

        for item in items:
            row = self._to_db_row(item)
            ok, reason = self._validate_row(row)
            if not ok:
                report.add_discard(reason or "unknown")
                discarded_records.append({
                    "reason": reason,
                    "row": row,
                    "model": type(item).__name__,
                })
                continue
            accepted_rows.append(row)

        # Merge rows that share the PK (e.g. KRX OHLCV + supply/demand for same date+ticker).
        merged = self._merge_by_pk(accepted_rows)

        # Upsert in batches.
        if merged:
            try:
                upserted = self._upsert(merged)
                report.accepted = upserted
            except Exception as exc:
                log.error("[%s] upsert failed (entire batch lost): %s", self.source, exc)
                report.discarded += len(merged)
                report.discard_reasons["upsert_error"] = (
                    report.discard_reasons.get("upsert_error", 0) + len(merged)
                )

        # Archive discards (best-effort).
        if discarded_records:
            try:
                report.storage_path = upload_raw(
                    f"discarded_{self.source}", discarded_records, on_date,
                )
            except Exception as exc:
                log.warning("[%s] discard archive failed (non-fatal): %s", self.source, exc)

        self._log_report(report)
        return report

    # ──────────────────────────────────────────────────────
    # Abstract — subclass duties
    # ──────────────────────────────────────────────────────
    @abstractmethod
    def _to_db_row(self, item: BaseModel) -> dict[str, Any]:
        """Convert a validated Pydantic model into a DB row dict."""

    @abstractmethod
    def _validate_row(self, row: dict[str, Any]) -> tuple[bool, str | None]:
        """Semantic validation — return (False, reason) to discard."""

    def _merge_by_pk(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Default: no merging (override for KRX which has 2 models per (date, ticker))."""
        return rows

    @abstractmethod
    def _upsert(self, rows: list[dict[str, Any]]) -> int:
        """Persist rows to Supabase. Returns the count actually written."""

    # ──────────────────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────────────────
    def _log_report(self, report: RefineryReport) -> None:
        msg = (
            "[%s/%s] accepted=%d discarded=%d duplicates=%d "
            "discard_rate=%.1f%% (expected 10-20%%)"
        )
        args = (self.source, report.on_date.isoformat(), report.accepted,
                report.discarded, report.duplicates, report.discard_rate * 100)
        if report.is_within_expected_range:
            log.info(msg, *args)
        else:
            log.warning("⚠️ DISCARD RATE OUT OF BAND " + msg, *args)
        if report.discard_reasons:
            top = sorted(report.discard_reasons.items(), key=lambda kv: -kv[1])[:5]
            log.info("[%s] top discard reasons: %s", self.source, top)
