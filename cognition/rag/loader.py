"""Read RAG chunk YAML files into validated Pydantic models.

Chunks live at cognition/rag/chunks/<sector>/<chunk_id>.yaml. The loader is
strict: every field defined in SKILL.md §7 must be present, otherwise the
chunk is rejected with a clear error.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, Field

CHUNKS_DIR = Path(__file__).parent / "chunks"


class RawChunk(BaseModel):
    """On-disk chunk format. Mirrors `rag_chunks` table columns."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=3, max_length=50, pattern=r"^[a-z0-9_]+$")
    topic: str = Field(min_length=5)
    markets: list[str] = Field(min_length=1)             # e.g. ['US', 'KR']
    sectors: list[str] = Field(min_length=1)
    related_tickers: list[str] = Field(min_length=1)
    trigger_conditions: list[str] = Field(min_length=1)
    positive_signal: str                                 # e.g. '강한 관심'
    risk_warning: str
    body: str = Field(min_length=50)
    historical_examples: list[str] = Field(default_factory=list)


def load_chunks(directory: Path | None = None) -> list[RawChunk]:
    """Walk `directory` (or default chunks/) and return validated chunks."""
    base = directory or CHUNKS_DIR
    if not base.exists():
        return []

    chunks: list[RawChunk] = []
    for path in sorted(base.rglob("*.yaml")):
        with path.open(encoding="utf-8") as fh:
            data: Any = yaml.safe_load(fh)
        if data is None:
            raise ValueError(f"Empty chunk file: {path}")
        try:
            chunks.append(RawChunk.model_validate(data))
        except Exception as exc:
            raise ValueError(f"Invalid chunk at {path}: {exc}") from exc
    return chunks
