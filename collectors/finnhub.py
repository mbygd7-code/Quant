"""Finnhub collector — global indices, equities, FX, company news.

Free tier: 60 req/min. We use an asyncio.Semaphore + 1.5 s pacing so a full
17-equity + 6-index + FX + news pass takes ~40 s and stays well under the
limit. CLAUDE.md §I says SDK only (no MCP) for batch collection.

Indices and FX coverage on Finnhub free tier is patchy — failures for those
are logged to `result.failed` but do NOT abort the run.
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import UTC, datetime, timedelta
from datetime import date as Date
from typing import Any

from pydantic import ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from collectors.__schemas__.global_ import FxQuote, GlobalNews, GlobalQuote
from collectors._base import BaseCollector, CollectorResult
from collectors.utils.business_days import prev_us_business_day

log = logging.getLogger("collectors.finnhub")

# Symbols by asset class
INDICES = ["^IXIC", "^GSPC", "^SOX", "^DJI", "^RUT", "^VIX"]
EQUITIES = [
    "NVDA", "AMD", "MU", "TSM", "ASML",
    "TSLA", "RIVN", "F", "GM",
    "AAPL", "MSFT", "GOOGL", "META",
    "LLY", "MRK", "PFE", "NVO", "BIIB",
]
# (Finnhub forex endpoint, our canonical symbol)
FX_PAIRS: list[tuple[str, str]] = [
    ("OANDA:USD_KRW", "USDKRW"),
    ("OANDA:DXY",     "DXY"),
]

# Free-tier safety: 60/min ≈ 1 req per second. 1.5 s gives margin for retries.
# Read at call time (NOT module-import time) so tests can override via env or monkeypatch.
def _req_interval() -> float:
    return float(os.environ.get("FINNHUB_REQ_INTERVAL", "1.5"))


def _concurrency() -> int:
    return int(os.environ.get("FINNHUB_CONCURRENCY", "4"))


class FinnhubCollector(BaseCollector):
    source_name = "finnhub"

    def __init__(self, api_key: str | None = None):
        self._api_key = api_key or os.environ.get("FINNHUB_API_KEY")
        if not self._api_key:
            raise RuntimeError("FINNHUB_API_KEY not set")

    # ──────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────
    def fetch(self, on_date: Date) -> CollectorResult:
        """Sync facade. Internally async — works whether or not the caller is
        already inside a running event loop (orchestrator pipeline is)."""
        target = prev_us_business_day(on_date)
        log.info("Finnhub collecting for US trading day %s (run-date %s KST)",
                 target.isoformat(), on_date.isoformat())
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            # No running loop → safe to use asyncio.run directly.
            return asyncio.run(self._fetch_all(target))
        # Already inside an event loop (e.g. orchestrator.pipeline). asyncio.run()
        # cannot nest, so dispatch onto a worker thread that owns its own loop.
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(asyncio.run, self._fetch_all(target)).result()

    # ──────────────────────────────────────────────────────
    # Async core
    # ──────────────────────────────────────────────────────
    async def _fetch_all(self, target: Date) -> CollectorResult:
        result = CollectorResult()
        sem = asyncio.Semaphore(_concurrency())
        client = self._build_client()

        raw: dict[str, Any] = {"date": target.isoformat(), "quotes": [], "news": [], "fx": []}

        # 1) Equities via Finnhub /quote
        equity_tasks = [
            self._fetch_quote(client, sem, sym, "equity", target, raw, result)
            for sym in EQUITIES
        ]
        # 2) FX rates via Finnhub
        fx_tasks = [
            self._fetch_fx(client, sem, finnhub_sym, our_sym, target, raw, result)
            for finnhub_sym, our_sym in FX_PAIRS
        ]
        # 3) News (per-equity, last 24h) via Finnhub
        news_window_start = target - timedelta(days=1)
        news_tasks = [
            self._fetch_news(client, sem, sym, news_window_start, target, raw, result)
            for sym in EQUITIES
        ]

        await asyncio.gather(*equity_tasks, *fx_tasks, *news_tasks)

        # 4) Indices via yfinance — Finnhub free tier doesn't expose ^IXIC etc.
        # Run after Finnhub gather so we don't compete for asyncio thread budget.
        try:
            await asyncio.to_thread(self._fetch_indices_yfinance, target, raw, result)
        except Exception as exc:
            log.warning("[finnhub] yfinance indices fetch failed: %s", exc)

        # Backup raw
        try:
            result.raw_storage_path = self._backup_raw(raw, target)
        except Exception as exc:
            log.warning("Finnhub raw backup failed (non-fatal): %s", exc)

        log.info("Finnhub done — success=%d failed=%d (rate %.1f%%)",
                 result.success_count, result.failure_count, result.success_rate * 100)
        return result

    # ──────────────────────────────────────────────────────
    # Per-call helpers (each pacing-aware)
    # ──────────────────────────────────────────────────────
    async def _fetch_quote(
        self, client, sem, symbol: str, asset_class: str,
        target: Date, raw: dict, result: CollectorResult,
    ) -> None:
        async with sem:
            await asyncio.sleep(_req_interval())
            try:
                data = await asyncio.to_thread(self._call_quote, client, symbol)
                raw["quotes"].append({"symbol": symbol, "asset_class": asset_class, "data": data})
                # data: {c, h, l, o, pc, t, d, dp}  — close, prev_close, change %, etc.
                if not data or data.get("c") in (None, 0):
                    raise RuntimeError(f"empty quote payload for {symbol}")
                quote = GlobalQuote(
                    date=target,
                    symbol=symbol,
                    close=float(data["c"]),
                    change_rate=(float(data["dp"]) / 100.0) if data.get("dp") is not None else None,
                    volume=None,                                     # /quote endpoint omits volume
                    asset_class=asset_class,                         # type: ignore[arg-type]
                )
                result.items.append(quote)
            except ValidationError as exc:
                self._record_failure(result, symbol, exc)
            except Exception as exc:
                self._record_failure(result, symbol, exc)

    async def _fetch_fx(
        self, client, sem, finnhub_sym: str, our_sym: str,
        target: Date, raw: dict, result: CollectorResult,
    ) -> None:
        async with sem:
            await asyncio.sleep(_req_interval())
            try:
                # Finnhub FX uses /quote with broker-prefixed symbols.
                data = await asyncio.to_thread(self._call_quote, client, finnhub_sym)
                raw["fx"].append({"symbol": our_sym, "data": data})
                if not data or not data.get("c"):
                    raise RuntimeError(f"empty FX payload for {finnhub_sym}")
                fx = FxQuote(
                    date=target,
                    symbol=our_sym,
                    close=float(data["c"]),
                    change_rate=(float(data["dp"]) / 100.0) if data.get("dp") is not None else None,
                )
                result.items.append(fx)
            except Exception as exc:
                self._record_failure(result, our_sym, exc)

    async def _fetch_news(
        self, client, sem, symbol: str, since: Date, until: Date,
        raw: dict, result: CollectorResult,
    ) -> None:
        async with sem:
            await asyncio.sleep(_req_interval())
            try:
                items = await asyncio.to_thread(
                    self._call_news, client, symbol, since.isoformat(), until.isoformat(),
                )
                raw["news"].append({"symbol": symbol, "count": len(items)})
                for item in items:
                    try:
                        news = GlobalNews(
                            published_at=datetime.fromtimestamp(item["datetime"], tz=UTC),
                            source=item.get("source", "finnhub"),
                            title=item.get("headline", "").strip(),
                            body=item.get("summary"),
                            url=item.get("url"),
                            related_symbols=[symbol],
                        )
                        result.items.append(news)
                    except (ValidationError, KeyError, TypeError) as exc:
                        self._record_failure(result, f"{symbol}/news#{item.get('id')}", exc)
            except Exception as exc:
                self._record_failure(result, f"{symbol}/news", exc)

    # ──────────────────────────────────────────────────────
    # yfinance indices — Finnhub free tier doesn't quote ^IXIC etc.
    # Runs in a worker thread (sync yfinance call).
    # ──────────────────────────────────────────────────────
    def _fetch_indices_yfinance(
        self, target: Date, raw: dict, result: CollectorResult,
    ) -> None:
        import yfinance as yf

        # Pull a small window so we have a previous close even after long weekends.
        start = (target - timedelta(days=10)).isoformat()
        end = (target + timedelta(days=2)).isoformat()      # exclusive

        df = yf.download(
            tickers=INDICES,
            start=start, end=end,
            group_by="ticker", progress=False, threads=True, auto_adjust=False,
        )
        if df is None or df.empty:
            log.warning("[finnhub] yfinance returned empty for indices")
            for sym in INDICES:
                self._record_failure(result, sym, RuntimeError("yfinance empty"))
            return

        for sym in INDICES:
            try:
                # Multi-symbol → MultiIndex columns; single-symbol → flat.
                ticker_df = df[sym] if len(INDICES) > 1 else df
                ticker_df = ticker_df.dropna(subset=["Close"])
                if ticker_df.empty:
                    self._record_failure(result, sym, RuntimeError("no close in window"))
                    continue

                # Find row at-or-before target (Yahoo can lag a day on indices).
                target_mask = ticker_df.index.date == target
                if target_mask.any():
                    target_row = ticker_df[target_mask].iloc[0]
                else:
                    candidates = ticker_df[ticker_df.index.date <= target]
                    if candidates.empty:
                        self._record_failure(result, sym, RuntimeError("no row at-or-before target"))
                        continue
                    target_row = candidates.iloc[-1]

                target_idx = ticker_df.index.get_loc(target_row.name)
                prev_close = (
                    float(ticker_df["Close"].iloc[target_idx - 1])
                    if target_idx > 0 else None
                )
                close = float(target_row["Close"])
                change_rate = (close - prev_close) / prev_close if prev_close else None

                quote = GlobalQuote(
                    date=target,
                    symbol=sym,
                    close=close,
                    change_rate=change_rate,
                    volume=None,
                    asset_class="index",                          # type: ignore[arg-type]
                )
                result.items.append(quote)
                raw["quotes"].append({
                    "symbol": sym, "asset_class": "index",
                    "data": {"c": close, "dp": (change_rate or 0) * 100, "source": "yfinance"},
                })
            except ValidationError as exc:
                self._record_failure(result, sym, exc)
            except Exception as exc:
                log.warning("[yfinance] %s parse failed: %s", sym, exc)
                self._record_failure(result, sym, exc)

    # ──────────────────────────────────────────────────────
    # Sync SDK wrappers (run via asyncio.to_thread)
    # ──────────────────────────────────────────────────────
    def _build_client(self):
        import finnhub  # lazy — heavy dep
        return finnhub.Client(api_key=self._api_key)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type(Exception),
        reraise=True,
    )
    def _call_quote(self, client, symbol: str) -> dict[str, Any]:
        return client.quote(symbol)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type(Exception),
        reraise=True,
    )
    def _call_news(self, client, symbol: str, _from: str, to: str) -> list[dict[str, Any]]:
        return client.company_news(symbol, _from=_from, to=to)
