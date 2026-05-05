"""Prediction — output of signals.gbm, written to predictions table."""
from __future__ import annotations

from datetime import date as Date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

VolatilityLabel = Literal["low", "medium", "high"]
GapRiskLabel = Literal["low", "medium", "high"]


class Prediction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: Date
    ticker: str
    prob_up: float = Field(ge=0.0, le=1.0,
        description="P(next-day return >= 1%) from GBM predict_proba.")
    expected_volatility: VolatilityLabel
    gap_risk: GapRiskLabel
    model_confidence: float = Field(ge=0.0, le=1.0,
        description="|prob_up - 0.5| * 2 — proximity to a confident class boundary.")
    model_version: str
