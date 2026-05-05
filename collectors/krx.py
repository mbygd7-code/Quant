"""KRX collector via pykrx SDK.

Fetches OHLCV + foreign/institution net buy for the watchlist (50 tickers
from `stocks.is_watchlist=TRUE`). pykrx is synchronous and KRX has a daily
quota of ~10 000 calls — well above our 50 × 2 = 100 calls/day budget,
so no rate-limiting is needed here.

Data freshness: pipeline runs at 06:00 KST, so 'today' has no market data
yet. This collector resolves the most recent KRX trading day via
`prev_kr_business_day(on_date)` and fetches that.
"""
from __future__ import annotations

import logging
from datetime import date as Date
from typing import Any

from pydantic import ValidationError

from collectors.__schemas__.korea import KoreaQuote, KoreaSupplyDemand
from collectors._base import BaseCollector, CollectorResult
from collectors.utils.business_days import prev_kr_business_day
from db.supabase_client import get_admin_client

log = logging.getLogger("collectors.krx")


class KrxCollector(BaseCollector):
    source_name = "krx"

    def __init__(self, tickers: list[str] | None = None):
        # `tickers=None` → load watchlist from DB (default for production).
        # Tests pass an explicit list.
        self._explicit_tickers = tickers

    # ──────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────
    def fetch(self, on_date: Date) -> CollectorResult:
        target = prev_kr_business_day(on_date)
        log.info("KRX collecting for trading day %s (run-date %s)",
                 target.isoformat(), on_date.isoformat())

        tickers = self._explicit_tickers or self._load_watchlist()
        if not tickers:
            raise RuntimeError("KrxCollector: empty ticker list (watchlist not seeded?)")

        result = CollectorResult()

        # 1) Bulk OHLCV — single pykrx call returns DataFrame indexed by ticker.
        try:
            ohlcv_df = self._fetch_ohlcv_bulk(target)
        except Exception as exc:
            log.error("KRX bulk OHLCV failed: %s", exc)
            ohlcv_df = None
            self._record_failure(result, "bulk_ohlcv", exc)

        # 2) Per-ticker validation + supply/demand
        raw_payload: dict[str, Any] = {"date": target.isoformat(), "items": []}
        for ticker in tickers:
            try:
                quote = self._build_quote(ticker, target, ohlcv_df)
                supply = self._fetch_supply_demand(ticker, target)
                raw_payload["items"].append({
                    "ticker": ticker,
                    "quote": quote.model_dump(mode="json"),
                    "supply": supply.model_dump(mode="json") if supply else None,
                })
                result.items.append(quote)
                if supply is not None:
                    result.items.append(supply)
            except ValidationError as exc:
                self._record_failure(result, ticker, exc)
            except Exception as exc:
                self._record_failure(result, ticker, exc)

        # 3) Archive raw payload
        try:
            result.raw_storage_path = self._backup_raw(raw_payload, target)
        except Exception as exc:
            log.warning("KRX raw backup failed (non-fatal): %s", exc)

        log.info("KRX done — success=%d failed=%d (rate %.1f%%)",
                 result.success_count, result.failure_count, result.success_rate * 100)
        return result

    # ──────────────────────────────────────────────────────
    # Internals
    # ──────────────────────────────────────────────────────
    def _load_watchlist(self) -> list[str]:
        sb = get_admin_client()
        rows = (
            sb.table("stocks")
              .select("ticker")
              .eq("is_watchlist", True)
              .execute()
              .data
        )
        return [r["ticker"] for r in rows if r.get("ticker", "").isdigit() and len(r["ticker"]) == 6]

    @BaseCollector._retry()
    def _fetch_ohlcv_bulk(self, target: Date):
        """Returns DataFrame indexed by ticker with columns 시가/고가/저가/종가/거래량/거래대금/등락률."""
        from pykrx import stock  # imported lazily — heavy dep, not for apps/api

        ymd = target.strftime("%Y%m%d")
        df = stock.get_market_ohlcv_by_ticker(ymd, market="ALL")
        if df is None or df.empty:
            raise RuntimeError(f"pykrx returned empty OHLCV for {ymd}")
        return df

    def _build_quote(self, ticker: str, target: Date, ohlcv_df) -> KoreaQuote:
        if ohlcv_df is None or ticker not in ohlcv_df.index:
            raise RuntimeError(f"ticker {ticker} not in bulk OHLCV result")
        row = ohlcv_df.loc[ticker]
        return KoreaQuote(
            date=target,
            ticker=ticker,
            open=int(row["시가"]) if row["시가"] else None,
            high=int(row["고가"]) if row["고가"] else None,
            low=int(row["저가"]) if row["저가"] else None,
            close=int(row["종가"]) if row["종가"] else None,
            volume=int(row["거래량"]) if row["거래량"] else None,
            trading_value=int(row["거래대금"]) if row["거래대금"] else None,
            change_rate=float(row["등락률"]) / 100.0 if row["등락률"] is not None else None,
        )

    @BaseCollector._retry()
    def _fetch_supply_demand(self, ticker: str, target: Date) -> KoreaSupplyDemand | None:
        """Per-ticker foreigner/institution net-buy in KRW."""
        from pykrx import stock

        ymd = target.strftime("%Y%m%d")
        df = stock.get_market_trading_value_by_date(ymd, ymd, ticker)
        if df is None or df.empty:
            return None

        row = df.iloc[0]
        return KoreaSupplyDemand(
            date=target,
            ticker=ticker,
            foreign_net_buy=int(row.get("외국인합계", 0)),
            institution_net_buy=int(row.get("기관합계", 0)),
        )
