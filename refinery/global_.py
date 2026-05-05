"""FinnhubRefiner — global quotes + FX + news → global_market / news_items.

Three collector model kinds, two destination tables:
  - GlobalQuote / FxQuote → global_market   (PK: date, symbol)
  - GlobalNews            → news_items      (PK: id auto, url UNIQUE)

Discard rules:
  Quotes / FX
    - future_date
    - non_positive_close
    - extreme_change_equity     : |change_rate| > 0.50
    - extreme_change_index      : |change_rate| > 0.20  (indices move slowly)
    - unknown_symbol            : not present in stocks table
  News
    - empty_title
    - too_short                 : title + body < 100 chars (likely ad)
    - duplicate_url             : URL already in news_items
"""
from __future__ import annotations

from datetime import date as Date
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from collectors.__schemas__.global_ import FxQuote, GlobalNews, GlobalQuote
from refinery._base import BaseRefiner
from refinery.utils.upsert import chunked_upsert, find_existing_news_urls, known_tickers

KST = ZoneInfo("Asia/Seoul")
EQUITY_DAILY_CAP = 0.50      # ±50% — circuit breakers + stock splits
INDEX_DAILY_CAP = 0.20       # ±20% — index moves rarely exceed this
NEWS_MIN_LENGTH = 100


class FinnhubRefiner(BaseRefiner):
    """Two-table refiner. We override `refine_and_upsert` to dispatch by model kind."""

    source = "finnhub"
    table_name = "global_market"   # primary; news handled separately

    def __init__(self, symbol_whitelist: set[str] | None = None):
        self._whitelist = symbol_whitelist
        # Lazy-fetched per refine pass:
        self._existing_urls: set[str] = set()

    def _whitelist_lazy(self) -> set[str]:
        if self._whitelist is None:
            self._whitelist = known_tickers()
        return self._whitelist

    # ──────────────────────────────────────────────────────
    # Override entrypoint — split items by destination table
    # ──────────────────────────────────────────────────────
    def refine_and_upsert(self, items: list[BaseModel], on_date: Date):
        # Pre-fetch existing URLs once so news dedup is O(1) thereafter.
        candidate_urls = [
            str(it.url) for it in items if isinstance(it, GlobalNews)
        ]
        self._existing_urls = find_existing_news_urls(candidate_urls)

        # Split: market (Quote+FX) vs news.
        market_items = [it for it in items if isinstance(it, GlobalQuote | FxQuote)]
        news_items   = [it for it in items if isinstance(it, GlobalNews)]

        # 1) Market — use base machinery.
        market_report = super().refine_and_upsert(market_items, on_date)

        # 2) News — separate run that targets news_items table.
        news_refiner = _NewsRefiner(
            symbol_whitelist=self._whitelist, existing_urls=self._existing_urls,
        )
        news_report = news_refiner.refine_and_upsert(news_items, on_date)

        # Merge into a single combined report.
        market_report.accepted   += news_report.accepted
        market_report.discarded  += news_report.discarded
        market_report.duplicates += news_report.duplicates
        for reason, count in news_report.discard_reasons.items():
            market_report.discard_reasons[reason] = (
                market_report.discard_reasons.get(reason, 0) + count
            )
        return market_report

    # ──────────────────────────────────────────────────────
    # Market rows (Quote + FX)
    # ──────────────────────────────────────────────────────
    def _to_db_row(self, item: BaseModel) -> dict[str, Any]:
        if isinstance(item, GlobalQuote):
            return {
                "date": item.date.isoformat(),
                "symbol": item.symbol,
                "close": item.close,
                "change_rate": item.change_rate,
                "volume": item.volume,
                "asset_class": item.asset_class,
                "_kind": item.asset_class,           # for validation only
            }
        if isinstance(item, FxQuote):
            return {
                "date": item.date.isoformat(),
                "symbol": item.symbol,
                "close": item.close,
                "change_rate": item.change_rate,
                "volume": None,
                "asset_class": "fx",
                "_kind": "fx",
            }
        raise TypeError(f"FinnhubRefiner cannot handle {type(item).__name__}")

    def _validate_row(self, row: dict[str, Any]) -> tuple[bool, str | None]:
        today = datetime.now(tz=KST).date()
        on_date = Date.fromisoformat(row["date"])

        if on_date > today:
            return False, "future_date"
        if not row.get("close") or row["close"] <= 0:
            return False, "non_positive_close"
        if row["symbol"] not in self._whitelist_lazy():
            return False, "unknown_symbol"

        chg = row.get("change_rate")
        if chg is not None:
            cap = INDEX_DAILY_CAP if row["_kind"] == "index" else EQUITY_DAILY_CAP
            if abs(chg) > cap:
                return False, "extreme_change_index" if row["_kind"] == "index" else "extreme_change_equity"
        return True, None

    def _to_db_row_clean(self, row: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in row.items() if not k.startswith("_")}

    def _upsert(self, rows: list[dict[str, Any]]) -> int:
        clean = [self._to_db_row_clean(r) for r in rows]
        return chunked_upsert(self.table_name, clean, on_conflict="date,symbol")


# ──────────────────────────────────────────────────────────
# Internal: dedicated news refiner (different table + dedup rules)
# ──────────────────────────────────────────────────────────
class _NewsRefiner(BaseRefiner):
    source = "finnhub"
    table_name = "news_items"

    def __init__(self, symbol_whitelist: set[str] | None, existing_urls: set[str]):
        self._whitelist = symbol_whitelist
        self._existing_urls = existing_urls

    def _to_db_row(self, item: BaseModel) -> dict[str, Any]:
        if not isinstance(item, GlobalNews):
            raise TypeError(f"_NewsRefiner cannot handle {type(item).__name__}")
        return {
            "date":            item.published_at.date().isoformat(),
            "published_at":    item.published_at.isoformat(),
            "source":          item.source,
            "title":           item.title.strip(),
            "body":            item.body,
            "url":             str(item.url),
            "related_symbols": item.related_symbols,
            # sentiment_* and embedding stay NULL — Prompt 04 fills them.
        }

    def _validate_row(self, row: dict[str, Any]) -> tuple[bool, str | None]:
        if not row["title"]:
            return False, "empty_title"
        combined_len = len(row["title"]) + len(row.get("body") or "")
        if combined_len < NEWS_MIN_LENGTH:
            return False, "too_short"
        if row["url"] in self._existing_urls:
            return False, "duplicate_url"
        # Mark as seen now so two news items with the same URL in this batch don't both pass.
        self._existing_urls.add(row["url"])
        return True, None

    def _upsert(self, rows: list[dict[str, Any]]) -> int:
        # `url` has UNIQUE constraint → on_conflict='url' upserts cleanly.
        return chunked_upsert(self.table_name, rows, on_conflict="url")
