"""SentimentResult — structured output for cognition.sentiment LLM calls.

CLAUDE.md §C: sentiment_score is float [0.0, 1.0], label is one of 5 enum values.
The Anthropic tool schema generated from this model enforces the contract.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

SentimentLabel = Literal[
    "very_negative", "negative", "neutral", "positive", "very_positive"
]
ImportanceLabel = Literal["low", "medium", "high"]


class SentimentResult(BaseModel):
    """Per-news LLM analysis. Stored on news_items.sentiment_* + importance."""

    model_config = ConfigDict(extra="forbid")

    sentiment_score: float = Field(
        ge=0.0, le=1.0,
        description="Continuous score: 0.0=very negative, 0.5=neutral, 1.0=very positive.",
    )
    sentiment_label: SentimentLabel = Field(
        description="Coarse 5-bucket label aligned with sentiment_score.",
    )
    related_symbols: list[str] = Field(
        default_factory=list,
        description="Stock symbols (KR 6-digit or US ticker) this article materially affects.",
    )
    importance: ImportanceLabel = Field(
        description="Market-impact magnitude regardless of polarity.",
    )
    reasoning: str = Field(
        max_length=400,
        description="One or two sentences (Korean) explaining the score, "
                    "without forbidden words ('매수', '확정', '보장', '100%' etc).",
    )
