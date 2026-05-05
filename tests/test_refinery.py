"""Refinery — semantic validation + 14.45% discard rate simulation.

CLAUDE.md §B: refinery is expected to discard ~14% of raw rows due to KRX
data quirks. We synthesize 100 rows with exactly 15 intentional defects and
assert that exactly those 15 are discarded with the right reasons.
"""
from __future__ import annotations

import random
from datetime import date as Date
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

from collectors.__schemas__.global_ import FxQuote, GlobalNews, GlobalQuote
from collectors.__schemas__.korea import KoreaQuote
from refinery._base import RefineryReport
from refinery.global_ import FinnhubRefiner
from refinery.korea import KrxRefiner

# Whitelist used by the rule tests AND the 100-row simulation.
# Must contain "005930" (rule tests) and "000001"-"000050" (simulation generator).
WATCHLIST = {"005930", "000660"} | {f"{i:06d}" for i in range(1, 51)}


# ───────────────────────────────────────────────────────────
# RefineryReport math
# ───────────────────────────────────────────────────────────
class TestRefineryReport:
    def test_discard_rate_zero_when_empty(self):
        r = RefineryReport(source="krx", on_date=Date(2026, 5, 4))
        assert r.discard_rate == 0.0
        assert r.is_within_expected_range is True   # vacuous

    def test_within_expected_band(self):
        r = RefineryReport(source="krx", on_date=Date(2026, 5, 4),
                           accepted=85, discarded=15)
        assert r.discard_rate == 0.15
        assert r.is_within_expected_range is True

    def test_outside_expected_band(self):
        r = RefineryReport(source="krx", on_date=Date(2026, 5, 4),
                           accepted=70, discarded=30)
        assert r.discard_rate == 0.30
        assert r.is_within_expected_range is False


# ───────────────────────────────────────────────────────────
# KrxRefiner — per-rule validation
# ───────────────────────────────────────────────────────────
class TestKrxRefinerRules:
    today = Date(2026, 5, 4)

    def _refiner(self):
        # Inject ticker whitelist so we don't hit DB.
        return KrxRefiner(ticker_whitelist=WATCHLIST)

    def _quote_row(self, **overrides):
        base = {
            "_kind": "quote",
            "date": self.today.isoformat(),
            "ticker": "005930",
            "open": 70_000, "high": 71_000, "low": 69_500, "close": 70_500,
            "volume": 1_000_000, "trading_value": 70_000_000_000,
            "change_rate": 0.0071,
        }
        base.update(overrides)
        return base

    def test_accepts_clean_row(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            ok, _ = self._refiner()._validate_row(self._quote_row())
        assert ok

    def test_rejects_future_date(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            row = self._quote_row(date=(self.today + timedelta(days=1)).isoformat())
            ok, reason = self._refiner()._validate_row(row)
        assert not ok and reason == "future_date"

    def test_rejects_stale_date(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            row = self._quote_row(date=(self.today - timedelta(days=45)).isoformat())
            ok, reason = self._refiner()._validate_row(row)
        assert not ok and reason == "stale_date"

    def test_rejects_unknown_ticker(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            ok, reason = self._refiner()._validate_row(self._quote_row(ticker="999999"))
        assert not ok and reason == "unknown_ticker"

    def test_rejects_low_above_high(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            row = self._quote_row(low=72_000, high=71_000)
            ok, reason = self._refiner()._validate_row(row)
        assert not ok and reason == "ohlc_inconsistent"

    def test_rejects_open_outside_range(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            row = self._quote_row(open=72_000)   # > high 71_000
            ok, reason = self._refiner()._validate_row(row)
        assert not ok and "ohlc_inconsistent" in reason

    def test_rejects_extreme_change(self):
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            row = self._quote_row(change_rate=0.45)   # > 30% cap
            ok, reason = self._refiner()._validate_row(row)
        assert not ok and reason == "extreme_change"


# ───────────────────────────────────────────────────────────
# Merge by PK — KRX OHLCV + supply/demand for same (date, ticker)
# ───────────────────────────────────────────────────────────
class TestKrxMerge:
    def test_merge_combines_quote_and_supply(self):
        r = KrxRefiner(ticker_whitelist=WATCHLIST)
        rows = [
            {"_kind": "quote",  "date": "2026-05-04", "ticker": "005930",
             "open": 70000, "high": 71000, "low": 69500, "close": 70500,
             "volume": 1_000_000, "trading_value": 70_000_000_000, "change_rate": 0.007},
            {"_kind": "supply", "date": "2026-05-04", "ticker": "005930",
             "foreign_net_buy": 5_000_000_000, "institution_net_buy": -2_000_000_000},
        ]
        merged = r._merge_by_pk(rows)
        assert len(merged) == 1
        m = merged[0]
        assert m["close"] == 70500                          # from quote
        assert m["foreign_net_buy"] == 5_000_000_000        # from supply
        assert m["institution_net_buy"] == -2_000_000_000
        assert "_kind" not in m


# ───────────────────────────────────────────────────────────
# 14.45% simulation — full refine_and_upsert flow with mocked upsert
# ───────────────────────────────────────────────────────────
class TestDiscardRateSimulation:
    """CLAUDE.md §B: synthesize 100 rows with 15 intentional errors → expect discarded == 15."""

    @patch("refinery._base.upload_raw", return_value="2026-05-04/discarded_krx.json")
    @patch("refinery.korea.chunked_upsert", return_value=85)
    def test_15_intentional_errors_caught(self, _mock_upsert, _mock_storage):
        random.seed(42)
        items = self._make_quotes(n=100, error_count=15)
        refiner = KrxRefiner(ticker_whitelist=WATCHLIST)

        # Freeze "today" so future_date logic is deterministic.
        with patch("refinery.korea.datetime") as dt:
            dt.now.return_value.date.return_value = Date(2026, 5, 4)
            dt.fromisoformat = datetime.fromisoformat
            report = refiner.refine_and_upsert(items, on_date=Date(2026, 5, 4))

        assert report.discarded == 15, f"expected 15 discards, got {report.discarded}: {report.discard_reasons}"
        assert report.accepted == 85
        assert 0.10 <= report.discard_rate <= 0.20
        assert report.is_within_expected_range is True

    def _make_quotes(self, n: int, error_count: int) -> list[KoreaQuote]:
        """Build n KoreaQuote rows with `error_count` intentional defects."""
        clean_count = n - error_count
        items: list[KoreaQuote] = []

        for i in range(clean_count):
            items.append(KoreaQuote(
                date=Date(2026, 5, 4),
                ticker=f"{(i % 50) + 1:06d}",
                open=70000 + i, high=71000 + i, low=69500 + i, close=70500 + i,
                volume=1_000_000, trading_value=70_000_000_000,
                change_rate=0.005,
            ))

        # 15 intentional defects spread across distinct rule violations.
        defect_specs = [
            # 5 future_date
            *[("future", i) for i in range(5)],
            # 4 unknown_ticker  (use 999xxx which is not in whitelist 000001-000059)
            *[("unknown_ticker", i) for i in range(4)],
            # 3 extreme_change
            *[("extreme_change", i) for i in range(3)],
            # 3 ohlc_inconsistent (low > high)
            *[("ohlc_inconsistent", i) for i in range(3)],
        ]
        assert len(defect_specs) == error_count

        for kind, i in defect_specs:
            if kind == "future":
                items.append(KoreaQuote(
                    date=Date(2026, 5, 10),         # > today (2026-05-04)
                    ticker="005930",
                    close=70000, change_rate=0.01,
                ))
            elif kind == "unknown_ticker":
                items.append(KoreaQuote(
                    date=Date(2026, 5, 4),
                    ticker=f"99{i:04d}",
                    close=70000, change_rate=0.01,
                ))
            elif kind == "extreme_change":
                items.append(KoreaQuote(
                    date=Date(2026, 5, 4),
                    ticker="005930",
                    open=70_000, high=71_000, low=69_500, close=70_500,
                    change_rate=0.55,                # > 30% cap
                ))
            elif kind == "ohlc_inconsistent":
                items.append(KoreaQuote(
                    date=Date(2026, 5, 4),
                    ticker="005930",
                    open=70_000, high=69_000, low=72_000, close=70_500,   # low > high
                    change_rate=0.01,
                ))
        return items


# ───────────────────────────────────────────────────────────
# FinnhubRefiner — quote + news split
# ───────────────────────────────────────────────────────────
class TestFinnhubRefiner:
    today = Date(2026, 5, 4)

    @patch("refinery.global_.find_existing_news_urls", return_value=set())
    @patch("refinery.global_.chunked_upsert",
           side_effect=lambda table, rows, **kw: len(rows))
    def test_split_market_and_news(self, mock_upsert, _mock_existing):
        items = [
            GlobalQuote(date=self.today, symbol="NVDA", close=900.5,
                        change_rate=0.02, asset_class="equity"),
            FxQuote(date=self.today, symbol="USDKRW", close=1380.0, change_rate=-0.001),
            GlobalNews(
                published_at=datetime(2026, 5, 4, 12, 0, 0),
                source="reuters",
                title="Nvidia announces new GPU lineup with major performance gains for AI workloads",
                body="Long detailed body text " * 10,
                url="https://example.com/n/1",
                related_symbols=["NVDA"],
            ),
        ]
        whitelist = {"NVDA", "USDKRW"}
        refiner = FinnhubRefiner(symbol_whitelist=whitelist)

        with patch("refinery.global_.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            dt.fromisoformat = datetime.fromisoformat
            report = refiner.refine_and_upsert(items, on_date=self.today)

        assert report.accepted >= 2     # at least the 2 market rows
        # chunked_upsert called twice: once for global_market, once for news_items.
        assert mock_upsert.call_count == 2

    @patch("refinery.global_.find_existing_news_urls",
           return_value={"https://example.com/dup"})
    @patch("refinery.global_.chunked_upsert",
           side_effect=lambda table, rows, **kw: len(rows))
    def test_duplicate_news_url_dropped(self, _mock_upsert, _mock_existing):
        items = [
            GlobalNews(
                published_at=datetime(2026, 5, 4, 12, 0, 0),
                source="reuters", title="some headline that is plenty long enough abc",
                body="x" * 100, url="https://example.com/dup",
                related_symbols=["NVDA"],
            ),
        ]
        refiner = FinnhubRefiner(symbol_whitelist={"NVDA"})

        with patch("refinery.global_.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            dt.fromisoformat = datetime.fromisoformat
            report = refiner.refine_and_upsert(items, on_date=self.today)

        assert report.discarded == 1
        assert report.discard_reasons.get("duplicate_url") == 1

    @patch("refinery.global_.find_existing_news_urls", return_value=set())
    @patch("refinery.global_.chunked_upsert",
           side_effect=lambda table, rows, **kw: len(rows))
    def test_index_extreme_change_dropped(self, _mock_upsert, _mock_existing):
        items = [
            GlobalQuote(date=self.today, symbol="^IXIC", close=15000.0,
                        change_rate=0.25,                # > 20% cap for indices
                        asset_class="index"),
        ]
        refiner = FinnhubRefiner(symbol_whitelist={"^IXIC"})

        with patch("refinery.global_.datetime") as dt:
            dt.now.return_value.date.return_value = self.today
            dt.fromisoformat = datetime.fromisoformat
            report = refiner.refine_and_upsert(items, on_date=self.today)

        assert report.discarded == 1
        assert report.discard_reasons.get("extreme_change_index") == 1


# ───────────────────────────────────────────────────────────
# orchestrate.refine_all — dispatcher
# ───────────────────────────────────────────────────────────
class TestRefineAll:
    def test_dispatches_to_krx(self):
        """_REFINERS dict is built at module import; patch the entry directly."""
        from collectors._base import CollectorResult
        from refinery import orchestrate, refine_all
        mock_cls = MagicMock()
        mock_instance = mock_cls.return_value
        with patch.dict(orchestrate._REFINERS, {"krx": mock_cls}):
            refine_all(CollectorResult(items=[]), source="krx", on_date=Date(2026, 5, 4))
        mock_instance.refine_and_upsert.assert_called_once()

    def test_unknown_source_raises(self):
        from collectors._base import CollectorResult
        from refinery import refine_all
        with pytest.raises(ValueError, match="Unknown source"):
            refine_all(CollectorResult(), source="bloomberg", on_date=Date(2026, 5, 4))
