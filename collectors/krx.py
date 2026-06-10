"""KR market collector — yfinance primary, pykrx fallback.

Data freshness: pipeline runs at 06:00 KST, so 'today' has no market data
yet. The collector resolves the most recent KRX trading day via
`prev_kr_business_day(on_date)` and fetches that.

Why two backends:
  - pykrx scrapes KRX directly. Reliable from KR-resident IPs but flaky
    from foreign / cloud-runner IPs (KRX returns empty bodies → JSON
    decode errors).
  - yfinance pulls from Yahoo Finance (.KS for KOSPI, .KQ for KOSDAQ).
    Stable globally but ~15-min delayed and lacks KR-specific fields
    (foreign / institution net buy).

Strategy:
  1. Try yfinance for OHLCV first.
  2. If yfinance fails entirely or returns nothing useful, fall back to pykrx.
  3. Foreign / institution net buy is pykrx-only; per-ticker failures are
     swallowed (the row just lacks supply data — refinery treats as NULL).
"""
from __future__ import annotations

import logging
from datetime import date as Date
from datetime import timedelta
from typing import Any

from pydantic import ValidationError

from collectors.__schemas__.korea import KoreaQuote, KoreaSupplyDemand
from collectors._base import BaseCollector, CollectorResult
from collectors.utils.business_days import prev_kr_business_day
from db.supabase_client import get_admin_client

log = logging.getLogger("collectors.krx")

# OHLCV backends return a unified shape:
#   {"open": int|None, "high": ..., "low": ..., "close": ...,
#    "volume": int|None, "trading_value": int|None, "change_rate": float|None}


class KrxCollector(BaseCollector):
    source_name = "krx"

    def __init__(self, watchlist: list[dict[str, str]] | None = None):
        # `watchlist=None` → load from DB (default for production).
        # Tests pass `[{"ticker": "005930", "market": "KOSPI"}, ...]`.
        self._explicit_watchlist = watchlist

    # ──────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────
    def fetch(self, on_date: Date) -> CollectorResult:
        target = prev_kr_business_day(on_date)
        log.info("KRX collecting for trading day %s (run-date %s)",
                 target.isoformat(), on_date.isoformat())

        watchlist = self._explicit_watchlist or self._load_watchlist()
        if not watchlist:
            raise RuntimeError("KrxCollector: empty watchlist (stocks not seeded?)")

        result = CollectorResult()
        ohlcv_data = self._fetch_ohlcv_with_fallback(target, watchlist, result)

        # Per-ticker validation + supply/demand
        raw_payload: dict[str, Any] = {"date": target.isoformat(), "items": []}
        for row in watchlist:
            ticker = row["ticker"]
            try:
                quote = self._build_quote(ticker, target, ohlcv_data)
                supply = self._fetch_supply_demand_safe(ticker, target)
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

        # Archive raw payload
        try:
            result.raw_storage_path = self._backup_raw(raw_payload, target)
        except Exception as exc:
            log.warning("KRX raw backup failed (non-fatal): %s", exc)

        log.info("KRX done — success=%d failed=%d (rate %.1f%%)",
                 result.success_count, result.failure_count, result.success_rate * 100)
        return result

    # ──────────────────────────────────────────────────────
    # Watchlist
    # ──────────────────────────────────────────────────────
    def _load_watchlist(self) -> list[dict[str, str]]:
        sb = get_admin_client()
        rows = (
            sb.table("stocks")
              .select("ticker, market")
              .eq("is_watchlist", True)
              .execute()
              .data
        ) or []
        return [
            {"ticker": r["ticker"], "market": r.get("market") or "KOSPI"}
            for r in rows
            if r.get("ticker", "").isdigit() and len(r["ticker"]) == 6
        ]

    # ──────────────────────────────────────────────────────
    # OHLCV — yfinance primary, pykrx fallback
    # ──────────────────────────────────────────────────────
    def _fetch_ohlcv_with_fallback(
        self,
        target: Date,
        watchlist: list[dict[str, str]],
        result: CollectorResult,
    ) -> dict[str, dict]:
        """Returns dict[ticker, ohlcv_dict]. Empty dict on total failure."""
        try:
            data = self._fetch_ohlcv_yfinance(target, watchlist)
            if data:
                log.info("[krx] yfinance OHLCV: %d/%d tickers", len(data), len(watchlist))
                return data
            log.warning("[krx] yfinance returned no usable data — trying pykrx")
        except Exception as exc:
            log.warning("[krx] yfinance failed (%s) — trying pykrx", exc)

        try:
            data = self._fetch_ohlcv_pykrx(target)
            log.info("[krx] pykrx OHLCV (fallback): %d tickers", len(data))
            return data
        except Exception as exc:
            log.error("[krx] both yfinance and pykrx failed: %s", exc)
            self._record_failure(result, "bulk_ohlcv", exc)
            return {}

    @BaseCollector._retry()
    def _fetch_ohlcv_yfinance(
        self, target: Date, watchlist: list[dict[str, str]],
    ) -> dict[str, dict]:
        """Pull OHLCV via Yahoo Finance. Returns dict keyed by 6-digit ticker."""
        import pandas as pd
        import yfinance as yf

        sym_to_ticker = {
            self._yf_symbol(r["ticker"], r["market"]): r["ticker"]
            for r in watchlist
        }
        if not sym_to_ticker:
            return {}

        # Pull a 10-day window so we have prev_close even after long weekends.
        start = (target - timedelta(days=10)).isoformat()
        end = (target + timedelta(days=2)).isoformat()      # exclusive end

        df = yf.download(
            tickers=list(sym_to_ticker.keys()),
            start=start, end=end,
            group_by="ticker", progress=False, threads=True, auto_adjust=False,
        )
        if df is None or df.empty:
            raise RuntimeError(f"yfinance returned empty for {target}")

        out: dict[str, dict] = {}
        for yf_sym, ticker in sym_to_ticker.items():
            try:
                ticker_df = df[yf_sym] if len(sym_to_ticker) > 1 else df
                ticker_df = ticker_df.dropna(subset=["Close"])
                if ticker_df.empty:
                    continue

                # Find row whose date matches target (Yahoo sometimes lags one day).
                target_mask = ticker_df.index.date == target
                if not target_mask.any():
                    # Use the most recent row at-or-before target.
                    candidates = ticker_df[ticker_df.index.date <= target]
                    if candidates.empty:
                        continue
                    target_row = candidates.iloc[-1]
                else:
                    target_row = ticker_df[target_mask].iloc[0]

                # prev_close = the row immediately before target
                target_idx = ticker_df.index.get_loc(target_row.name)
                prev_close = (
                    float(ticker_df["Close"].iloc[target_idx - 1])
                    if target_idx > 0 else None
                )
                close = float(target_row["Close"])
                change_rate = (close - prev_close) / prev_close if prev_close else None

                out[ticker] = {
                    "open":          int(target_row["Open"])  if pd.notna(target_row["Open"])  else None,
                    "high":          int(target_row["High"])  if pd.notna(target_row["High"])  else None,
                    "low":           int(target_row["Low"])   if pd.notna(target_row["Low"])   else None,
                    "close":         int(close),
                    "volume":        int(target_row["Volume"]) if pd.notna(target_row["Volume"]) else None,
                    "trading_value": None,                      # yfinance doesn't expose this
                    "change_rate":   change_rate,
                }
            except Exception as exc:
                log.warning("[yfinance] %s parse failed: %s", ticker, exc)
        return out

    @staticmethod
    def _yf_symbol(ticker: str, market: str) -> str:
        suffix = ".KS" if (market or "KOSPI").upper() == "KOSPI" else ".KQ"
        return f"{ticker}{suffix}"

    @BaseCollector._retry()
    def _fetch_ohlcv_pykrx(self, target: Date) -> dict[str, dict]:
        """Original pykrx path — kept as fallback (returns same dict shape)."""
        import pandas as pd
        from pykrx import stock

        ymd = target.strftime("%Y%m%d")
        frames: list[pd.DataFrame] = []
        for market in ("KOSPI", "KOSDAQ"):
            try:
                part = stock.get_market_ohlcv_by_ticker(ymd, market=market)
                if part is not None and not part.empty:
                    frames.append(part)
            except Exception as exc:
                log.warning("[krx] pykrx %s failed: %s", market, exc)

        if not frames:
            raise RuntimeError(f"pykrx returned no OHLCV for {ymd}")

        df = pd.concat(frames)
        df = df[~df.index.duplicated(keep="first")]
        required = {"시가", "고가", "저가", "종가", "거래량", "거래대금", "등락률"}
        missing = required - set(df.columns)
        if missing:
            raise RuntimeError(f"pykrx OHLCV missing columns: {sorted(missing)}")

        out: dict[str, dict] = {}
        for ticker, row in df.iterrows():
            out[ticker] = {
                "open":          int(row["시가"])     if row["시가"]     else None,
                "high":          int(row["고가"])     if row["고가"]     else None,
                "low":           int(row["저가"])     if row["저가"]     else None,
                "close":         int(row["종가"])     if row["종가"]     else None,
                "volume":        int(row["거래량"])   if row["거래량"]   else None,
                "trading_value": int(row["거래대금"]) if row["거래대금"] else None,
                "change_rate":   float(row["등락률"]) / 100.0 if row["등락률"] is not None else None,
            }
        return out

    # ──────────────────────────────────────────────────────
    # Quote builder — single code path for either backend
    # ──────────────────────────────────────────────────────
    def _build_quote(
        self, ticker: str, target: Date, ohlcv_data: dict[str, dict],
    ) -> KoreaQuote:
        if ticker not in ohlcv_data:
            raise RuntimeError(f"ticker {ticker} not in OHLCV result")
        d = ohlcv_data[ticker]
        return KoreaQuote(
            date=target,
            ticker=ticker,
            open=d.get("open"),
            high=d.get("high"),
            low=d.get("low"),
            close=d.get("close"),
            volume=d.get("volume"),
            trading_value=d.get("trading_value"),
            change_rate=d.get("change_rate"),
        )

    # ──────────────────────────────────────────────────────
    # Supply / demand — NAVER investor-trend API; tolerate failure
    # ──────────────────────────────────────────────────────
    def _fetch_supply_demand_safe(
        self, ticker: str, target: Date,
    ) -> KoreaSupplyDemand | None:
        try:
            return self._fetch_supply_demand(ticker, target)
        except Exception as exc:
            # warning (not debug): this exact path was silently dead for
            # the project's entire life — pykrx's investor-flow endpoint
            # started requiring a KRX datacenter login (KRX_ID/KRX_PW)
            # and every call failed invisibly at debug level. korea_market
            # ended up with ZERO foreign_net_buy rows. Keep failures
            # visible.
            log.warning("[krx] supply/demand for %s unavailable: %s", ticker, exc)
            return None

    @BaseCollector._retry()
    def _fetch_supply_demand(self, ticker: str, target: Date) -> KoreaSupplyDemand | None:
        """Foreigner/institution net buy via NAVER's investor-trend API.

        Replaces pykrx `get_market_trading_value_by_date`, which now
        requires a KRX datacenter login and has therefore never returned
        a single row in this deployment.

        NAVER reports net-buy QUANTITY (shares); the schema (and
        Shiller's ±5조 saturation) expect KRW value, so we approximate
        value = quantity × that day's close. This is the standard
        approximation (intraday VWAP unavailable) and is documented at
        the call sites that consume it.
        """
        rows = _naver_investor_trend(ticker)
        ymd = target.strftime("%Y%m%d")
        for r in rows:
            if r.get("bizdate") != ymd:
                continue
            close = _parse_signed_int(r.get("closePrice"))
            frgn = _parse_signed_int(r.get("foreignerPureBuyQuant"))
            organ = _parse_signed_int(r.get("organPureBuyQuant"))
            if close is None:
                return None
            return KoreaSupplyDemand(
                date=target,
                ticker=ticker,
                foreign_net_buy=frgn * close if frgn is not None else None,
                institution_net_buy=organ * close if organ is not None else None,
            )
        return None


#: NAVER mobile investor-trend endpoint — same host as the kr_news
#: collector; no auth required. Returns the latest N trading days of
#: per-investor net-buy quantities (외국인/기관/개인) plus close.
NAVER_TREND_ENDPOINT = "https://m.stock.naver.com/api/stock/{ticker}/trend"


def _naver_investor_trend(ticker: str, page_size: int = 10) -> list[dict]:
    """Fetch the latest `page_size` daily investor-trend rows."""
    import httpx

    resp = httpx.get(
        NAVER_TREND_ENDPOINT.format(ticker=ticker),
        params={"pageSize": page_size, "page": 1},
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            ),
            "Accept": "application/json",
        },
        timeout=10.0,
    )
    resp.raise_for_status()
    body = resp.json()
    return body if isinstance(body, list) else []


def _parse_signed_int(text) -> int | None:
    """'+1,767,022' / '-1,596,173' / '322,000' → int. None on junk."""
    if text is None:
        return None
    try:
        return int(str(text).replace(",", "").replace("+", "").strip())
    except ValueError:
        return None
