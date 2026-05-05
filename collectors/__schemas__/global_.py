"""Global market schemas — equities, indices, FX, news.

Module is named `global_` (trailing underscore) because `global` is a
Python reserved keyword and cannot be used as a module identifier.
"""
from __future__ import annotations

from datetime import date as Date
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

AssetClass = Literal["equity", "index", "fx", "commodity", "rate", "etf"]


class GlobalQuote(BaseModel):
    """Daily close + change for a US/global symbol."""

    model_config = ConfigDict(extra="forbid")

    date: Date
    symbol: str = Field(min_length=1, max_length=20)
    close: float | None = None
    change_rate: float | None = None        # decimal — 0.018 = +1.8%
    volume: int | None = Field(default=None, ge=0)
    asset_class: AssetClass


class FxQuote(BaseModel):
    """Spot FX rate (close-of-day proxy)."""

    model_config = ConfigDict(extra="forbid")

    date: Date
    symbol: str = Field(min_length=1, max_length=20)   # 'USDKRW', 'DXY'
    close: float = Field(gt=0)
    change_rate: float | None = None


class GlobalNews(BaseModel):
    """Single news article from Finnhub `company_news`."""

    model_config = ConfigDict(extra="forbid")

    published_at: datetime
    source: str
    title: str = Field(min_length=1)
    body: str | None = None
    url: HttpUrl
    related_symbols: list[str] = Field(default_factory=list)
