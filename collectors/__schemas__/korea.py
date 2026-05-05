"""Korea market schemas — KRX OHLCV + foreigner/institution net buy."""
from __future__ import annotations

from datetime import date as Date

from pydantic import BaseModel, ConfigDict, Field


class KoreaQuote(BaseModel):
    """Daily OHLCV for a single KR ticker."""

    model_config = ConfigDict(extra="forbid")

    date: Date
    ticker: str = Field(pattern=r"^\d{6}$")
    open: int | None = Field(default=None, ge=0)
    high: int | None = Field(default=None, ge=0)
    low: int | None = Field(default=None, ge=0)
    close: int | None = Field(default=None, ge=0)
    volume: int | None = Field(default=None, ge=0)
    trading_value: int | None = Field(default=None, ge=0)
    change_rate: float | None = None


class KoreaSupplyDemand(BaseModel):
    """Daily foreigner / institutional net-buy in KRW."""

    model_config = ConfigDict(extra="forbid")

    date: Date
    ticker: str = Field(pattern=r"^\d{6}$")
    foreign_net_buy: int | None = None      # 음수 = 순매도
    institution_net_buy: int | None = None
