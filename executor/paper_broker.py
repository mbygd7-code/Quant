"""PaperBroker — deterministic paper-trading on top of Supabase.

State lives in two tables (Prompt 01 migration):
  - paper_trades     : append-only ledger of buy/sell fills
  - paper_portfolio  : current (qty, avg_cost) per ticker

Fill semantics (Phase 1 MVP):
  - Limit order  (price set)  → fills immediately at the given price.
  - Market order (price=None) → fills at the last known korea_market.close
                                for that ticker. If no close exists the
                                order is rejected.

Backtest "next-day open" simulation (Prompt 10) sets price explicitly to
the realized open, so this simple machinery is enough for correctness.

cancel_order() reverses a prior fill by inserting an opposite trade with
identical qty + price; the avg_cost in paper_portfolio is recomputed.
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from executor.__schemas__.order import Balance, Order, OrderResult, Position
from executor.broker_interface import BrokerInterface
from executor.safety import check_execution_mode

if TYPE_CHECKING:
    pass

log = logging.getLogger("executor.paper_broker")

INITIAL_CAPITAL_KRW = 10_000_000


class PaperBroker(BrokerInterface):
    def __init__(
        self,
        user_id: str | None = None,
        *,
        initial_capital: int = INITIAL_CAPITAL_KRW,
        db=None,
    ) -> None:
        check_execution_mode()
        self._user_id = user_id or os.environ.get("PAPER_USER_ID", "")
        if not self._user_id:
            raise ValueError(
                "PaperBroker needs a user_id (or PAPER_USER_ID env). "
                "Use the operator's auth.users.id UUID."
            )
        self._initial_capital = initial_capital
        if db is None:
            from db.supabase_client import get_admin_client
            db = get_admin_client()
        self._db = db

    # ──────────────────────────────────────────────────────
    # Reads
    # ──────────────────────────────────────────────────────
    def get_balance(self) -> Balance:
        trades = self._fetch_trades()
        cash = self._initial_capital
        for t in trades:
            value = t["qty"] * t["price"]
            if t["side"] == "buy":
                cash -= value
            else:
                cash += value

        positions = self.get_positions()
        invested = sum(p.market_value for p in positions)
        total = max(cash, 0) + invested
        return Balance(
            cash=max(cash, 0),
            invested=invested,
            total_value=total,
            initial_capital=self._initial_capital,
        )

    def get_positions(self) -> list[Position]:
        rows = (
            self._db.table("paper_portfolio")
                .select("ticker, qty, avg_cost")
                .eq("user_id", self._user_id)
                .execute()
                .data
        ) or []
        out: list[Position] = []
        for row in rows:
            qty = int(row["qty"])
            if qty == 0:
                continue
            current = self._latest_close(row["ticker"]) or int(row["avg_cost"])
            out.append(Position(
                ticker=row["ticker"], qty=qty,
                avg_cost=int(row["avg_cost"]),
                current_price=current,
            ))
        return out

    # ──────────────────────────────────────────────────────
    # Writes
    # ──────────────────────────────────────────────────────
    def place_order(self, order: Order) -> OrderResult:
        fill_price = order.price if order.price is not None else self._latest_close(order.ticker)
        if fill_price is None or fill_price <= 0:
            raise RuntimeError(
                f"No reference price for {order.ticker}; market order rejected."
            )

        now = datetime.utcnow()
        order_id = str(uuid.uuid4())
        pnl = 0

        if order.side == "sell":
            pnl = self._compute_realized_pnl(order.ticker, order.qty, fill_price)

        # Append to paper_trades.
        self._db.table("paper_trades").insert({
            "id": order_id,
            "user_id": self._user_id,
            "date": now.date().isoformat(),
            "ticker": order.ticker,
            "side": order.side,
            "qty": order.qty,
            "price": fill_price,
            "triggered_by": order.triggered_by,
            "pnl": pnl,
        }).execute()

        # Update paper_portfolio.
        self._update_portfolio(order.ticker, order.side, order.qty, fill_price)

        return OrderResult(
            order_id=order_id,
            ticker=order.ticker,
            side=order.side,
            qty=order.qty,
            fill_price=fill_price,
            fill_value=order.qty * fill_price,
            pnl=pnl,
            filled_at=now,
        )

    def cancel_order(self, order_id: str) -> None:
        rows = (
            self._db.table("paper_trades")
                .select("ticker, side, qty, price")
                .eq("id", order_id)
                .eq("user_id", self._user_id)
                .limit(1)
                .execute()
                .data
        )
        if not rows:
            raise KeyError(f"order_id {order_id} not found for this user")
        original = rows[0]
        opposite_side = "sell" if original["side"] == "buy" else "buy"
        # Reverse trade — same qty + price.
        reverse = Order(
            ticker=original["ticker"],
            side=opposite_side,
            qty=int(original["qty"]),
            price=int(original["price"]),
            triggered_by=f"cancel:{order_id}",
        )
        self.place_order(reverse)

    # ──────────────────────────────────────────────────────
    # Internals
    # ──────────────────────────────────────────────────────
    def _fetch_trades(self) -> list[dict]:
        return (
            self._db.table("paper_trades")
                .select("ticker, side, qty, price, pnl")
                .eq("user_id", self._user_id)
                .execute()
                .data
        ) or []

    def _latest_close(self, ticker: str) -> int | None:
        rows = (
            self._db.table("korea_market")
                .select("close, date")
                .eq("ticker", ticker)
                .order("date", desc=True)
                .limit(1)
                .execute()
                .data
        )
        if not rows or not rows[0].get("close"):
            return None
        return int(rows[0]["close"])

    def _update_portfolio(self, ticker: str, side: str, qty: int, price: int) -> None:
        rows = (
            self._db.table("paper_portfolio")
                .select("qty, avg_cost")
                .eq("user_id", self._user_id)
                .eq("ticker", ticker)
                .limit(1)
                .execute()
                .data
        )
        existing_qty = int(rows[0]["qty"]) if rows else 0
        existing_avg = int(rows[0]["avg_cost"]) if rows else 0

        if side == "buy":
            new_qty = existing_qty + qty
            new_avg = (
                int((existing_qty * existing_avg + qty * price) / new_qty)
                if new_qty > 0 else 0
            )
        else:                                              # sell
            new_qty = existing_qty - qty
            if new_qty < 0:
                # Phase 1 disallows shorts.
                raise RuntimeError(
                    f"Cannot sell {qty} {ticker}: only {existing_qty} held"
                )
            new_avg = existing_avg if new_qty > 0 else 0

        self._db.table("paper_portfolio").upsert({
            "user_id": self._user_id,
            "ticker": ticker,
            "qty": new_qty,
            "avg_cost": new_avg,
        }, on_conflict="user_id,ticker").execute()

    def _compute_realized_pnl(self, ticker: str, qty: int, sell_price: int) -> int:
        rows = (
            self._db.table("paper_portfolio")
                .select("avg_cost, qty")
                .eq("user_id", self._user_id)
                .eq("ticker", ticker)
                .limit(1)
                .execute()
                .data
        )
        if not rows:
            return 0
        avg_cost = int(rows[0]["avg_cost"])
        return qty * (sell_price - avg_cost)
