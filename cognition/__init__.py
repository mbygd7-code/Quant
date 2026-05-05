"""LLM, embeddings, US-KR mapping, scoring.

Public surface:
  - SentimentEngine, SentimentResult       — Prompt 04 (this prompt)
  - Embedder                                — OpenAI text-embedding-3-small wrapper
  - mapper, rag                             — Prompt 05 (later)
  - scorer                                  — Prompt 06 (later)
"""
from cognition.__schemas__.sentiment import SentimentLabel, SentimentResult
from cognition.embedder import EMBEDDING_DIM, EMBEDDING_MODEL, Embedder
from cognition.mapper import calculate_related_us_score
from cognition.sentiment import SentimentEngine

__all__ = [
    "SentimentEngine",
    "SentimentResult",
    "SentimentLabel",
    "Embedder",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "calculate_related_us_score",
]
