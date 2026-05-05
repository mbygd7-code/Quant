"""executor — schemas, safety guard, PaperBroker, Phase 3 stubs."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

from executor.__schemas__.order import Balance, Order, Position
from executor.kis_broker import KISBroker
from executor.kiwoom_broker import KiwoomBroker
from executor.paper_broker import INITIAL_CAPITAL_KRW, PaperBroker
from executor.safety import (
    ALLOWED_MODES,
    LIVE_MODES,
    SecurityError,
    check_execution_mode,
)

USER_ID = "00000000-0000-0000-0000-000000000001"


# ───────────────────────────────────────────────────────────
# Schemas
# ───────────────────────────────────────────────────────────
class TestSchemas:
    def test_order_valid(self):
        o = Order(ticker="005930", side="buy", qty=10, price=70000)
        assert o.qty == 10
        assert o.price == 70000

    def test_order_market_order(self):
        o = Order(ticker="005930", side="sell", qty=5)        # price default None
        assert o.price is None

    def test_order_invalid_ticker(self):
        with pytest.raises(ValidationError):
            Order(ticker="ABC", side="buy", qty=1)

    def test_order_zero_qty_rejected(self):
        with pytest.raises(ValidationError):
            Order(ticker="005930", side="buy", qty=0)

    def test_order_unknown_side_rejected(self):
        with pytest.raises(ValidationError):
            Order(ticker="005930", side="hold", qty=1)        # type: ignore[arg-type]

    def test_position_pnl(self):
        p = Position(ticker="005930", qty=10, avg_cost=70000, current_price=72000)
        assert p.market_value == 720_000
        assert p.unrealized_pnl == 20_000

    def test_balance_total_return_pct(self):
        b = Balance(cash=5_000_000, invested=6_000_000,
                    total_value=11_000_000, initial_capital=10_000_000)
        assert b.total_return_pct == pytest.approx(0.1)


# ───────────────────────────────────────────────────────────
# Safety guard (CLAUDE.md section D)
# ───────────────────────────────────────────────────────────
class TestSafety:
    def test_default_mode_allowed(self, monkeypatch):
        monkeypatch.delenv("EXECUTION_MODE", raising=False)
        assert check_execution_mode() == "report_only"

    def test_paper_mode_allowed(self, monkeypatch):
        monkeypatch.setenv("EXECUTION_MODE", "paper")
        assert check_execution_mode() == "paper"

    @pytest.mark.parametrize("mode", sorted(LIVE_MODES))
    def test_live_modes_raise(self, monkeypatch, mode):
        monkeypatch.setenv("EXECUTION_MODE", mode)
        with pytest.raises(SecurityError, match="LIVE TRADING"):
            check_execution_mode()

    def test_unknown_mode_raises(self, monkeypatch):
        monkeypatch.setenv("EXECUTION_MODE", "casino")
        with pytest.raises(SecurityError, match="not recognized"):
            check_execution_mode()

    def test_allowed_modes_set(self):
        assert frozenset({"report_only", "paper"}) == ALLOWED_MODES


# ───────────────────────────────────────────────────────────
# Phase 3 stubs
# ───────────────────────────────────────────────────────────
class TestPhase3Stubs:
    def test_kis_broker_raises_on_init(self):
        with pytest.raises(NotImplementedError, match="Phase 3"):
            KISBroker()

    def test_kiwoom_broker_raises_on_init(self):
        with pytest.raises(NotImplementedError, match="Phase 3"):
            KiwoomBroker()


# ───────────────────────────────────────────────────────────
# PaperBroker — fully mocked Supabase
# ───────────────────────────────────────────────────────────
class _FakeSupabase:
    """Minimal table().select()...execute().data fluent stub."""

    def __init__(self) -> None:
        self.trades: list[dict] = []
        self.portfolio: dict[tuple[str, str], dict] = {}
        self.korea_market: dict[str, list[dict]] = {}      # ticker → list[{date, close}]

    def table(self, name: str):
        return _FakeTable(self, name)


class _FakeTable:
    def __init__(self, db: _FakeSupabase, name: str) -> None:
        self._db = db
        self._name = name
        self._filters: dict = {}
        self._select_cols: str | None = None
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._operation: str | None = None
        self._payload: dict | list | None = None

    # Query construction
    def select(self, cols: str):
        self._select_cols = cols
        return self

    def eq(self, col: str, val):
        self._filters[col] = val
        return self

    def order(self, col: str, *, desc: bool = False):
        self._order = (col, desc)
        return self

    def limit(self, n: int):
        self._limit = n
        return self

    # Mutations
    def insert(self, payload):
        self._operation = "insert"
        self._payload = payload
        return self

    def upsert(self, payload, *, on_conflict: str | None = None):
        self._operation = "upsert"
        self._payload = payload
        self._on_conflict = on_conflict
        return self

    # Terminal
    def execute(self):
        result = MagicMock()
        if self._operation in {"insert", "upsert"}:
            self._apply_mutation()
            result.data = []
            return result
        result.data = self._fetch()
        return result

    def _apply_mutation(self):
        if self._name == "paper_trades":
            self._db.trades.append(dict(self._payload))
        elif self._name == "paper_portfolio":
            row = dict(self._payload)
            self._db.portfolio[(row["user_id"], row["ticker"])] = row

    def _fetch(self):
        if self._name == "paper_trades":
            rows = list(self._db.trades)
        elif self._name == "paper_portfolio":
            rows = list(self._db.portfolio.values())
        elif self._name == "korea_market":
            # ticker is the dict key (rows don't carry a 'ticker' field), so consume
            # that filter here before the generic loop strips everything.
            ticker = self._filters.pop("ticker", "")
            rows = list(self._db.korea_market.get(ticker, []))
        else:
            rows = []

        # Filter
        for col, val in self._filters.items():
            rows = [r for r in rows if r.get(col) == val]

        # Order
        if self._order:
            col, desc = self._order
            rows.sort(key=lambda r: r.get(col, ""), reverse=desc)

        if self._limit is not None:
            rows = rows[: self._limit]
        return rows


@pytest.fixture
def fake_db():
    return _FakeSupabase()


@pytest.fixture
def broker(fake_db, monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "paper")
    return PaperBroker(user_id=USER_ID, db=fake_db)


class TestPaperBrokerLifecycle:
    def test_init_requires_user_id(self, fake_db, monkeypatch):
        monkeypatch.setenv("EXECUTION_MODE", "paper")
        monkeypatch.delenv("PAPER_USER_ID", raising=False)
        with pytest.raises(ValueError, match="PAPER_USER_ID"):
            PaperBroker(user_id="", db=fake_db)

    def test_init_uses_env_user_id(self, fake_db, monkeypatch):
        monkeypatch.setenv("EXECUTION_MODE", "paper")
        monkeypatch.setenv("PAPER_USER_ID", USER_ID)
        broker = PaperBroker(db=fake_db)
        assert broker._user_id == USER_ID

    def test_init_blocked_in_live_mode(self, fake_db, monkeypatch):
        monkeypatch.setenv("EXECUTION_MODE", "kis_real")
        with pytest.raises(SecurityError):
            PaperBroker(user_id=USER_ID, db=fake_db)


class TestPaperBrokerOrders:
    def test_buy_then_sell(self, broker, fake_db):
        # Buy 10 @ 70_000
        result1 = broker.place_order(Order(ticker="005930", side="buy",
                                            qty=10, price=70_000))
        assert result1.fill_price == 70_000
        assert result1.fill_value == 700_000
        # Position recorded
        positions = broker.get_positions()
        # current_price = avg_cost when no korea_market data
        assert len(positions) == 1
        assert positions[0].ticker == "005930"
        assert positions[0].qty == 10
        assert positions[0].avg_cost == 70_000

        # Sell 5 @ 72_000 → realized PnL = 5 * (72000 - 70000) = 10_000
        result2 = broker.place_order(Order(ticker="005930", side="sell",
                                            qty=5, price=72_000))
        assert result2.pnl == 10_000

        positions = broker.get_positions()
        assert positions[0].qty == 5

    def test_average_cost_after_two_buys(self, broker):
        broker.place_order(Order(ticker="005930", side="buy", qty=10, price=70_000))
        broker.place_order(Order(ticker="005930", side="buy", qty=10, price=80_000))
        positions = broker.get_positions()
        # (10*70000 + 10*80000) / 20 = 75_000
        assert positions[0].avg_cost == 75_000
        assert positions[0].qty == 20

    def test_sell_more_than_held_raises(self, broker):
        broker.place_order(Order(ticker="005930", side="buy", qty=5, price=70_000))
        with pytest.raises(RuntimeError, match="Cannot sell"):
            broker.place_order(Order(ticker="005930", side="sell", qty=10, price=70_000))

    def test_market_order_uses_latest_close(self, broker, fake_db):
        fake_db.korea_market["005930"] = [
            {"date": "2026-05-04", "close": 71_500},
            {"date": "2026-05-03", "close": 70_000},
        ]
        result = broker.place_order(Order(ticker="005930", side="buy", qty=1))
        assert result.fill_price == 71_500

    def test_market_order_no_data_rejected(self, broker):
        with pytest.raises(RuntimeError, match="No reference price"):
            broker.place_order(Order(ticker="999999", side="buy", qty=1))


class TestPaperBrokerBalance:
    def test_initial_balance_is_capital(self, broker):
        b = broker.get_balance()
        assert b.cash == INITIAL_CAPITAL_KRW
        assert b.invested == 0
        assert b.total_value == INITIAL_CAPITAL_KRW

    def test_balance_after_buy(self, broker, fake_db):
        broker.place_order(Order(ticker="005930", side="buy", qty=10, price=70_000))
        b = broker.get_balance()
        # cash = 10M - 700_000 = 9_300_000
        # invested = 10 * 70_000 = 700_000 (current_price defaults to avg_cost when no market data)
        assert b.cash == 9_300_000
        assert b.invested == 700_000
        assert b.total_value == 10_000_000

    def test_balance_with_unrealized_gain(self, broker, fake_db):
        broker.place_order(Order(ticker="005930", side="buy", qty=10, price=70_000))
        fake_db.korea_market["005930"] = [{"date": "2026-05-04", "close": 75_000}]
        b = broker.get_balance()
        assert b.cash == 9_300_000
        assert b.invested == 750_000               # 10 * 75_000 unrealized
        assert b.total_value == 10_050_000         # +50k unrealized gain


class TestPaperBrokerCancel:
    def test_cancel_inserts_reverse_trade(self, broker, fake_db):
        result = broker.place_order(Order(ticker="005930", side="buy", qty=10, price=70_000))
        broker.cancel_order(result.order_id)
        # Two trades: original buy + reverse sell
        assert len(fake_db.trades) == 2
        sides = [t["side"] for t in fake_db.trades]
        assert sides == ["buy", "sell"]
        # Position cleared
        positions = broker.get_positions()
        assert positions == []

    def test_cancel_unknown_raises(self, broker):
        with pytest.raises(KeyError):
            broker.cancel_order("unknown-id")
