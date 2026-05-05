"""KrxRefiner — semantic validation + (date,ticker) merge + upsert to korea_market.

Splits the work for two collector models:
  - KoreaQuote          → OHLCV columns
  - KoreaSupplyDemand   → foreign_net_buy / institution_net_buy

These share the (date, ticker) PK so we merge them into one row before upsert.

Discard rules — beyond what Pydantic catches:
  - future_date              : date > today_kst
  - stale_date               : date older than 30 days (mapping drift suspect)
  - ohlc_inconsistent        : low > high, or open/close outside [low, high]
  - ohlc_value_inconsistent  : trading_value < volume * low (arithmetic sanity)
  - extreme_change           : |change_rate| > 0.30 (KRX limit ±30%)
  - unknown_ticker           : not present in stocks table
"""
from __future__ import annotations

from datetime import date as Date
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from collectors.__schemas__.korea import KoreaQuote, KoreaSupplyDemand
from refinery._base import BaseRefiner
from refinery.utils.upsert import chunked_upsert, known_tickers

KST = ZoneInfo("Asia/Seoul")
STALE_DAYS = 30
KRX_DAILY_LIMIT = 0.30   # ±30% price change cap


class KrxRefiner(BaseRefiner):
    source = "krx"
    table_name = "korea_market"

    def __init__(self, ticker_whitelist: set[str] | None = None):
        # Allow injection in tests so we don't hit the DB.
        self._whitelist = ticker_whitelist

    def _whitelist_lazy(self) -> set[str]:
        if self._whitelist is None:
            self._whitelist = known_tickers()
        return self._whitelist

    # ──────────────────────────────────────────────────────
    # Row shaping
    # ──────────────────────────────────────────────────────
    def _to_db_row(self, item: BaseModel) -> dict[str, Any]:
        if isinstance(item, KoreaQuote):
            return {
                "_kind": "quote",
                "date": item.date.isoformat(),
                "ticker": item.ticker,
                "open": item.open,
                "high": item.high,
                "low": item.low,
                "close": item.close,
                "volume": item.volume,
                "trading_value": item.trading_value,
                "change_rate": item.change_rate,
            }
        if isinstance(item, KoreaSupplyDemand):
            return {
                "_kind": "supply",
                "date": item.date.isoformat(),
                "ticker": item.ticker,
                "foreign_net_buy": item.foreign_net_buy,
                "institution_net_buy": item.institution_net_buy,
            }
        raise TypeError(f"KrxRefiner cannot handle {type(item).__name__}")

    # ──────────────────────────────────────────────────────
    # Validation
    # ──────────────────────────────────────────────────────
    def _validate_row(self, row: dict[str, Any]) -> tuple[bool, str | None]:
        today = datetime.now(tz=KST).date()
        on_date = Date.fromisoformat(row["date"])

        if on_date > today:
            return False, "future_date"
        if (today - on_date).days > STALE_DAYS:
            return False, "stale_date"
        if row["ticker"] not in self._whitelist_lazy():
            return False, "unknown_ticker"

        if row["_kind"] == "quote":
            return self._validate_quote(row)
        return True, None   # supply rows have no further semantic checks

    def _validate_quote(self, row: dict[str, Any]) -> tuple[bool, str | None]:
        low, high = row.get("low"), row.get("high")
        op, cl = row.get("open"), row.get("close")
        vol, val = row.get("volume"), row.get("trading_value")
        chg = row.get("change_rate")

        if low is not None and high is not None and low > high:
            return False, "ohlc_inconsistent"
        for px_name, px in (("open", op), ("close", cl)):
            if (px is not None and low is not None and high is not None
                    and not (low <= px <= high)):
                return False, f"ohlc_inconsistent_{px_name}"
        if vol and val and low and val < vol * low * 0.5:
            # 50% leniency for intraday VWAP swings; below this it's clearly broken.
            return False, "ohlc_value_inconsistent"
        if chg is not None and abs(chg) > KRX_DAILY_LIMIT:
            return False, "extreme_change"
        return True, None

    # ──────────────────────────────────────────────────────
    # Merge two model kinds into a single row per (date, ticker)
    # ──────────────────────────────────────────────────────
    def _merge_by_pk(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        merged: dict[tuple[str, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["date"], row["ticker"])
            if key not in merged:
                merged[key] = {"date": row["date"], "ticker": row["ticker"]}
            target = merged[key]
            for k, v in row.items():
                if k in ("_kind", "date", "ticker"):
                    continue
                # Only overwrite NULL with non-NULL so OHLCV doesn't clobber supply or vice versa.
                if v is not None or k not in target:
                    target[k] = v
        return list(merged.values())

    # ──────────────────────────────────────────────────────
    # Upsert
    # ──────────────────────────────────────────────────────
    def _upsert(self, rows: list[dict[str, Any]]) -> int:
        return chunked_upsert(self.table_name, rows, on_conflict="date,ticker")
