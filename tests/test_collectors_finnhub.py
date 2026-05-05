"""FinnhubCollector — quote validation, partial failure, news mapping."""
from __future__ import annotations

from datetime import UTC, datetime
from datetime import date as Date
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from collectors.__schemas__.global_ import FxQuote, GlobalNews, GlobalQuote
from collectors.finnhub import FinnhubCollector


# ───────────────────────────────────────────────────────────
# Schema validation
# ───────────────────────────────────────────────────────────
class TestGlobalSchemas:
    def test_global_quote_valid(self):
        q = GlobalQuote(date=Date(2026, 5, 5), symbol="NVDA",
                        close=900.5, change_rate=0.018, asset_class="equity")
        assert q.symbol == "NVDA"

    def test_global_quote_rejects_bad_asset_class(self):
        with pytest.raises(ValidationError):
            GlobalQuote(date=Date(2026, 5, 5), symbol="NVDA",
                        close=900.5, asset_class="crypto")  # type: ignore[arg-type]

    def test_fx_quote_rejects_zero_close(self):
        with pytest.raises(ValidationError):
            FxQuote(date=Date(2026, 5, 5), symbol="USDKRW", close=0)

    def test_news_rejects_invalid_url(self):
        with pytest.raises(ValidationError):
            GlobalNews(
                published_at=datetime(2026, 5, 5, tzinfo=UTC),
                source="reuters", title="Big news", url="not-a-url",
                related_symbols=["NVDA"],
            )


# ───────────────────────────────────────────────────────────
# Collector behavior
# ───────────────────────────────────────────────────────────
def _quote_payload(close: float = 100.0, dp: float = 1.5):
    return {"c": close, "h": close * 1.01, "l": close * 0.99, "o": close * 0.995,
            "pc": close - 1, "t": 1735000000, "d": 1.5, "dp": dp}


def _news_payload(symbol: str, count: int = 2):
    return [
        {
            "id": i,
            "datetime": 1735000000 + i,
            "headline": f"{symbol} headline {i}",
            "summary": "summary",
            "source": "reuters",
            "url": f"https://example.com/{symbol}/{i}",
        }
        for i in range(count)
    ]


@pytest.fixture
def patched_finnhub(monkeypatch: pytest.MonkeyPatch):
    """Replace SDK calls with deterministic stubs."""
    fake_client = MagicMock()
    fake_client.quote.side_effect = lambda symbol: _quote_payload()
    fake_client.company_news.side_effect = lambda symbol, _from, to: _news_payload(symbol)

    monkeypatch.setattr(
        FinnhubCollector, "_build_client", lambda self: fake_client,
    )
    monkeypatch.setattr(
        "collectors.finnhub.prev_us_business_day", lambda d: Date(2026, 5, 4),
    )
    return fake_client


class TestFinnhubCollector:
    def test_full_pass_succeeds(self, patched_finnhub, mock_storage):
        coll = FinnhubCollector()
        result = coll.fetch(Date(2026, 5, 5))

        # 18 equities + 6 indices + 2 FX = 26 quote/fx items
        # + 18 equities × 2 news each = 36 news items → 62 total
        assert result.success_count == 62
        assert result.failure_count == 0
        assert mock_storage.called

    def test_quote_failure_partial(self, patched_finnhub, mock_storage):
        # NVDA returns empty payload → must be flagged as failure but loop continues.
        def quote_side_effect(symbol):
            if symbol == "NVDA":
                return {"c": 0}
            return _quote_payload()
        patched_finnhub.quote.side_effect = quote_side_effect

        coll = FinnhubCollector()
        result = coll.fetch(Date(2026, 5, 5))

        # NVDA quote failed (1) AND NVDA news still succeeds (still in EQUITIES list).
        assert result.failure_count == 1
        assert any(f["identifier"] == "NVDA" for f in result.failed)
        assert result.success_count >= 60

    def test_news_with_bad_url_skipped(self, patched_finnhub, mock_storage):
        def news_side_effect(symbol, _from, to):
            return [
                {"id": 1, "datetime": 1735000000, "headline": "ok",
                 "summary": "x", "source": "reuters", "url": "https://valid.com/1"},
                {"id": 2, "datetime": 1735000000, "headline": "broken",
                 "summary": "x", "source": "reuters", "url": "not-a-url"},
            ]
        patched_finnhub.company_news.side_effect = news_side_effect

        coll = FinnhubCollector()
        result = coll.fetch(Date(2026, 5, 5))

        # 18 equities × 1 valid news = 18 news kept; 18 invalid logged as failures.
        valid_news = [it for it in result.items if isinstance(it, GlobalNews)]
        assert len(valid_news) == 18
        news_failures = [f for f in result.failed if "/news#2" in f["identifier"]]
        assert len(news_failures) == 18

    def test_missing_api_key_raises(self, monkeypatch):
        monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="FINNHUB_API_KEY"):
            FinnhubCollector()

    def test_fetch_works_inside_running_event_loop(self, patched_finnhub, mock_storage):
        """Regression: orchestrator.pipeline runs inside asyncio.run, and the
        sync collectors are called from there. Naive `asyncio.run()` inside
        FinnhubCollector.fetch raises 'cannot be called from a running event
        loop' — the fix is to detect a live loop and dispatch to a worker
        thread that owns its own loop.
        """
        import asyncio as _asyncio

        async def driver():
            # Just calling fetch from inside `await` proves we are inside a
            # running loop — exactly the orchestrator scenario.
            coll = FinnhubCollector()
            return coll.fetch(Date(2026, 5, 5))

        result = _asyncio.run(driver())
        assert result.success_count > 0   # not aborted by RuntimeError
