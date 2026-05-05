"""Pydantic schemas for the executor layer."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

OrderSide = Literal["buy", "sell"]


class Order(BaseModel):
    """Request to buy/sell. price=None → market order, filled at last close."""

    model_config = ConfigDict(extra="forbid")

    ticker: str = Field(pattern=r"^\d{6}$",
        description="6-digit KR ticker (KOSPI/KOSDAQ).")
    side: OrderSide
    qty: int = Field(gt=0)
    price: int | None = Field(default=None, ge=0,
        description="Limit price in KRW. None = market order (fill at last close).")
    triggered_by: str = Field(default="manual",
        description="Source — 'manual', 'signal:강한관심', 'backtest:score_above_065', etc.")


class Position(BaseModel):
    """Currently-held position for one ticker."""

    model_config = ConfigDict(extra="forbid")

    ticker: str = Field(pattern=r"^\d{6}$")
    qty: int = Field(ge=0)
    avg_cost: int = Field(ge=0)
    current_price: int = Field(ge=0)

    @property
    def market_value(self) -> int:
        return self.qty * self.current_price

    @property
    def unrealized_pnl(self) -> int:
        return self.qty * (self.current_price - self.avg_cost)


class Balance(BaseModel):
    """Cash + invested value snapshot."""

    model_config = ConfigDict(extra="forbid")

    cash: int = Field(ge=0)
    invested: int = Field(ge=0)
    total_value: int = Field(ge=0)
    initial_capital: int = Field(gt=0)

    @property
    def total_return_pct(self) -> float:
        return (self.total_value - self.initial_capital) / self.initial_capital


class OrderResult(BaseModel):
    """Filled-trade record returned by place_order."""

    model_config = ConfigDict(extra="forbid")

    order_id: str
    ticker: str
    side: OrderSide
    qty: int
    fill_price: int
    fill_value: int                        # qty * fill_price (gross)
    pnl: int = 0                           # realized PnL (sells only)
    filled_at: datetime
