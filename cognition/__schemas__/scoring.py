"""AIScore — output of cognition.scorer, written to ai_scores table.

The 5-bucket signal mapping uses the active weight_configs row's
signal_threshold_* values when available, but the Pydantic model accepts any
of the 5 string labels for type safety.
"""
from __future__ import annotations

from datetime import date as Date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SignalLabel = Literal["강한 관심", "관심", "관망", "주의", "위험"]


class SubScores(BaseModel):
    """The 8 components of the SKILL.md section 3 weighted formula.

    The 8th — `kr_fear_greed` — was added on top of the original 7
    after the KR-specific Fear & Greed index (signals.kr_fear_greed)
    proved more defensible than scraping CNN's US-centric number.
    """

    model_config = ConfigDict(extra="forbid")

    global_market: float = Field(ge=0.0, le=1.0)
    sector: float = Field(ge=0.0, le=1.0)
    related_us_stock: float = Field(ge=0.0, le=1.0)
    news_sentiment: float = Field(ge=0.0, le=1.0)
    fundamental: float = Field(ge=0.0, le=1.0)
    volume_flow: float = Field(ge=0.0, le=1.0)
    risk_penalty: float = Field(ge=0.0, le=1.0)
    kr_fear_greed: float = Field(default=0.5, ge=0.0, le=1.0)


class Rationale(BaseModel):
    """Stub structure for ai_scores.rationale_json. Prompt 07's report
    generator will overwrite the strings with LLM-authored Korean prose."""

    model_config = ConfigDict(extra="forbid")

    evidence: list[str] = Field(min_length=3, max_length=3)
    risks: list[str] = Field(min_length=2, max_length=2)
    sub_scores: SubScores


class AIScore(BaseModel):
    """One row written to ai_scores."""

    model_config = ConfigDict(extra="forbid")

    date: Date
    ticker: str
    final_score: float = Field(ge=0.0, le=1.0)
    signal: SignalLabel
    sub_scores: SubScores
    rationale: Rationale
