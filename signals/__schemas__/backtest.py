"""Backtest schemas — params, per-trade records, aggregate metrics."""
from __future__ import annotations

from datetime import date as Date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Strategy = Literal["score_above_065", "strong_only", "top5_per_day"]


class BacktestParams(BaseModel):
    model_config = ConfigDict(extra="forbid")

    start_date: Date
    end_date: Date
    strategy: Strategy = "score_above_065"
    weight_config_id: str | None = None
    holding_days: int = Field(default=1, ge=1, le=10)
    commission_bps: int = Field(default=15, ge=0, le=100,
        description="Round-trip commission + slippage in basis points (0.15% default).")


class TradeRecord(BaseModel):
    """One simulated trade — written to backtest_results table."""

    model_config = ConfigDict(extra="forbid")

    strategy_id: str
    date: Date                                # entry date
    ticker: str
    signal: str
    entry_price: int
    exit_price: int
    actual_return: float
    hit: bool


class BacktestSummary(BaseModel):
    """Aggregate metrics returned by Backtest.run()."""

    model_config = ConfigDict(extra="forbid")

    strategy_id: str
    start_date: Date
    end_date: Date
    trade_count: int
    win_count: int
    win_rate: float
    avg_return: float
    cumulative_return: float
    sharpe_ratio: float
    max_drawdown: float
    by_signal: dict[str, dict[str, float]] = Field(default_factory=dict,
        description="{signal_name: {count, win_rate, avg_return}}")
    by_sector: dict[str, dict[str, float]] = Field(default_factory=dict,
        description="{sector: {count, avg_return}}")
