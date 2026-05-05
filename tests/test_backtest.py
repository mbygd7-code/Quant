"""signals.backtest — strategy filters, walk-forward simulation, metrics."""
from __future__ import annotations

from datetime import date as Date
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from signals.__schemas__.backtest import (
    BacktestParams,
    BacktestSummary,
    TradeRecord,
)
from signals.backtest import STRATEGY_FILTERS, Backtest


# ───────────────────────────────────────────────────────────
# Schemas
# ───────────────────────────────────────────────────────────
class TestParamsSchema:
    def test_default(self):
        p = BacktestParams(start_date=Date(2026, 1, 1), end_date=Date(2026, 4, 30))
        assert p.strategy == "score_above_065"
        assert p.holding_days == 1
        assert p.commission_bps == 15

    def test_invalid_strategy(self):
        with pytest.raises(ValidationError):
            BacktestParams(start_date=Date(2026, 1, 1),
                           end_date=Date(2026, 1, 31),
                           strategy="nonexistent")            # type: ignore[arg-type]

    def test_holding_days_bounds(self):
        with pytest.raises(ValidationError):
            BacktestParams(start_date=Date(2026, 1, 1),
                           end_date=Date(2026, 1, 31),
                           holding_days=0)


# ───────────────────────────────────────────────────────────
# Strategy filters
# ───────────────────────────────────────────────────────────
class TestStrategyFilters:
    def _rows(self):
        return [
            {"ticker": "A", "signal": "강한 관심", "final_score": 0.85},
            {"ticker": "B", "signal": "관심", "final_score": 0.70},
            {"ticker": "C", "signal": "관망", "final_score": 0.55},
            {"ticker": "D", "signal": "주의", "final_score": 0.40},
            {"ticker": "E", "signal": "위험", "final_score": 0.25},
            {"ticker": "F", "signal": "강한 관심", "final_score": 0.91},
            {"ticker": "G", "signal": "관심", "final_score": 0.66},
        ]

    def test_score_above_065(self):
        picks = STRATEGY_FILTERS["score_above_065"](self._rows())
        assert {p["ticker"] for p in picks} == {"A", "B", "F", "G"}

    def test_strong_only(self):
        picks = STRATEGY_FILTERS["strong_only"](self._rows())
        assert {p["ticker"] for p in picks} == {"A", "F"}

    def test_top5_per_day(self):
        picks = STRATEGY_FILTERS["top5_per_day"](self._rows())
        assert [p["ticker"] for p in picks] == ["F", "A", "B", "G", "C"]


# ───────────────────────────────────────────────────────────
# Backtest._max_drawdown
# ───────────────────────────────────────────────────────────
class TestMaxDrawdown:
    def test_no_drawdown(self):
        assert Backtest._max_drawdown([1.0, 1.1, 1.2, 1.3]) == 0.0

    def test_simple_drawdown(self):
        # peak 1.5 → trough 1.2 = -20%
        dd = Backtest._max_drawdown([1.0, 1.5, 1.2, 1.4])
        assert dd == pytest.approx(-0.2, abs=1e-9)

    def test_multiple_drawdowns_returns_largest(self):
        dd = Backtest._max_drawdown([1.0, 1.2, 0.9, 1.5, 0.6, 1.0])
        # peak 1.5 → trough 0.6 = -60%
        assert dd == pytest.approx(-0.6, abs=1e-9)


# ───────────────────────────────────────────────────────────
# End-to-end with synthetic Supabase
# ───────────────────────────────────────────────────────────
class _FakeBacktestDB:
    """Minimal stub returning canned data for the 4 tables Backtest reads."""

    def __init__(self, ai_scores=(), korea_market=(), stocks=()):
        self._tables = {
            "ai_scores": list(ai_scores),
            "korea_market": list(korea_market),
            "stocks": list(stocks),
            "backtest_results": [],
            "backtest_jobs": [],
        }

    def table(self, name):
        return _FakeBacktestTable(self._tables, name)


class _FakeBacktestTable:
    def __init__(self, tables, name):
        self._tables = tables
        self._name = name
        self._filters = []          # list of (op, col, val)
        self._payload = None
        self._operation = None

    def select(self, _):
        return self

    def gte(self, col, val):
        self._filters.append((">=", col, val))
        return self

    def lte(self, col, val):
        self._filters.append(("<=", col, val))
        return self

    def eq(self, col, val):
        self._filters.append(("==", col, val))
        return self

    def upsert(self, payload, *, on_conflict=None):
        self._operation = "upsert"
        self._payload = payload
        return self

    def update(self, payload):
        self._operation = "update"
        self._payload = payload
        return self

    def execute(self):
        result = MagicMock()
        if self._operation == "upsert":
            self._tables[self._name].extend(self._payload)
            result.data = []
            return result
        if self._operation == "update":
            result.data = []
            return result
        rows = list(self._tables.get(self._name, []))
        for op, col, val in self._filters:
            if op == "==":
                rows = [r for r in rows if r.get(col) == val]
            elif op == ">=":
                rows = [r for r in rows if r.get(col, "") >= val]
            elif op == "<=":
                rows = [r for r in rows if r.get(col, "") <= val]
        result.data = rows
        return result


class TestBacktestRun:
    def test_simple_two_day_trade(self):
        # Strategy picks ticker A on 2026-01-05 (entry 01-06 open, exit 01-07 open)
        ai_scores = [
            {"date": "2026-01-05", "ticker": "005930",
             "signal": "강한 관심", "final_score": 0.85},
        ]
        korea_market = [
            # entry day
            {"date": "2026-01-06", "ticker": "005930", "open": 70_000, "close": 71_000},
            # exit day
            {"date": "2026-01-07", "ticker": "005930", "open": 72_000, "close": 71_500},
        ]
        stocks = [{"ticker": "005930", "sector": "반도체"}]
        db = _FakeBacktestDB(ai_scores=ai_scores,
                              korea_market=korea_market,
                              stocks=stocks)

        params = BacktestParams(
            start_date=Date(2026, 1, 5), end_date=Date(2026, 1, 7),
            strategy="strong_only", commission_bps=0,
        )
        bt = Backtest(params, db=db)
        trades, summary = bt.run()

        assert len(trades) == 1
        t = trades[0]
        assert t.entry_price == 70_000
        assert t.exit_price == 72_000
        assert t.actual_return == pytest.approx((72_000 - 70_000) / 70_000)
        assert t.hit is True

        assert summary.trade_count == 1
        assert summary.win_count == 1
        assert summary.win_rate == 1.0
        assert summary.cumulative_return == pytest.approx((72_000 - 70_000) / 70_000)

    def test_no_market_data_skips_trade(self):
        ai_scores = [
            {"date": "2026-01-05", "ticker": "005930",
             "signal": "강한 관심", "final_score": 0.85},
        ]
        korea_market = [
            {"date": "2026-01-06", "ticker": "005930", "open": 70_000, "close": 71_000},
            # exit day missing
        ]
        db = _FakeBacktestDB(ai_scores=ai_scores, korea_market=korea_market)
        params = BacktestParams(
            start_date=Date(2026, 1, 5), end_date=Date(2026, 1, 6),
            strategy="strong_only",
        )
        bt = Backtest(params, db=db)
        trades, summary = bt.run()
        # Only one market day → no eligible exit → 0 trades
        assert trades == []
        assert summary.trade_count == 0

    def test_commission_reduces_return(self):
        ai_scores = [
            {"date": "2026-01-05", "ticker": "005930",
             "signal": "강한 관심", "final_score": 0.85},
        ]
        korea_market = [
            {"date": "2026-01-06", "ticker": "005930", "open": 100_000, "close": 100_000},
            {"date": "2026-01-07", "ticker": "005930", "open": 101_000, "close": 100_000},
        ]
        db = _FakeBacktestDB(ai_scores=ai_scores, korea_market=korea_market)
        # gross = +1%, commission = 50bps → net = 0.5%
        params = BacktestParams(
            start_date=Date(2026, 1, 5), end_date=Date(2026, 1, 7),
            strategy="strong_only", commission_bps=50,
        )
        bt = Backtest(params, db=db)
        trades, _ = bt.run()
        assert trades[0].actual_return == pytest.approx(0.01 - 0.005, abs=1e-9)


# ───────────────────────────────────────────────────────────
# BacktestSummary aggregator
# ───────────────────────────────────────────────────────────
class TestSummary:
    def _bt(self):
        params = BacktestParams(start_date=Date(2026, 1, 1), end_date=Date(2026, 1, 30))
        return Backtest(params, db=_FakeBacktestDB())

    def test_zero_trades_safe_summary(self):
        bt = self._bt()
        summary = bt._summarize([], {})
        assert isinstance(summary, BacktestSummary)
        assert summary.trade_count == 0
        assert summary.cumulative_return == 0.0

    def test_win_rate_computed(self):
        bt = self._bt()
        trades = [
            TradeRecord(strategy_id="x", date=Date(2026, 1, 6), ticker="005930",
                         signal="강한 관심", entry_price=100, exit_price=110,
                         actual_return=0.10, hit=True),
            TradeRecord(strategy_id="x", date=Date(2026, 1, 7), ticker="005930",
                         signal="강한 관심", entry_price=110, exit_price=99,
                         actual_return=-0.10, hit=False),
        ]
        summary = bt._summarize(trades, {"005930": "반도체"})
        assert summary.win_count == 1
        assert summary.win_rate == 0.5
        assert summary.by_signal["강한 관심"]["count"] == 2
        assert summary.by_sector["반도체"]["count"] == 2
