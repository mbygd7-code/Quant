"""cognition.rag — chunk loader validation + embedder + retriever."""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from cognition.embedder import EMBEDDING_DIM, Embedder
from cognition.rag.loader import RawChunk, load_chunks
from cognition.rag.retriever import retrieve

CHUNKS_DIR = Path(__file__).parent.parent / "cognition" / "rag" / "chunks"


# ───────────────────────────────────────────────────────────
# Schema + on-disk content
# ───────────────────────────────────────────────────────────
class TestChunkLoader:
    def test_loads_25_chunks_from_disk(self):
        chunks = load_chunks(CHUNKS_DIR)
        assert len(chunks) == 25, f"Expected 25 chunks, found {len(chunks)}"

    def test_each_sector_has_correct_count(self):
        chunks = load_chunks(CHUNKS_DIR)
        per_sector: dict[str, int] = {}
        for chunk in chunks:
            for sector in chunk.sectors:
                per_sector[sector] = per_sector.get(sector, 0) + 1
        assert per_sector["semiconductor"] >= 6
        assert per_sector["battery"] >= 5
        assert per_sector["auto"] >= 5
        assert per_sector["bio"] >= 4
        assert per_sector["internet"] >= 5

    def test_all_chunk_ids_unique(self):
        chunks = load_chunks(CHUNKS_DIR)
        ids = [c.id for c in chunks]
        assert len(ids) == len(set(ids)), "Duplicate chunk ids found"

    def test_nvda_hbm_chunk_present(self):
        chunks = load_chunks(CHUNKS_DIR)
        nvda = [c for c in chunks if c.id == "nvda_hbm_001"]
        assert len(nvda) == 1
        chunk = nvda[0]
        assert "000660" in chunk.related_tickers     # SK하이닉스
        assert "NVDA" in chunk.related_tickers
        assert "semiconductor" in chunk.sectors


class TestRawChunkSchema:
    def test_minimal_valid(self):
        c = RawChunk(
            id="test_001",
            topic="Test topic for the chunk",
            markets=["KR"],
            sectors=["semiconductor"],
            related_tickers=["005930"],
            trigger_conditions=["x"],
            positive_signal="관심",
            risk_warning="x",
            body="x" * 60,
        )
        assert c.id == "test_001"

    def test_id_pattern_enforced(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            RawChunk(
                id="UPPER-CASE!", topic="x", markets=["KR"], sectors=["s"],
                related_tickers=["005930"], trigger_conditions=["x"],
                positive_signal="x", risk_warning="x", body="x" * 60,
            )

    def test_short_body_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            RawChunk(
                id="short_001", topic="x", markets=["KR"], sectors=["s"],
                related_tickers=["005930"], trigger_conditions=["x"],
                positive_signal="x", risk_warning="x", body="too short",
            )

    def test_empty_required_list_rejected(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            RawChunk(
                id="empty_001", topic="x", markets=[],            # empty
                sectors=["s"], related_tickers=["005930"],
                trigger_conditions=["x"],
                positive_signal="x", risk_warning="x", body="x" * 60,
            )


# ───────────────────────────────────────────────────────────
# Retriever — mock RPC + Embedder
# ───────────────────────────────────────────────────────────
class TestRetriever:
    def _mock_embedder(self):
        emb = MagicMock(spec=Embedder)
        emb.embed = AsyncMock(return_value=[0.0] * EMBEDDING_DIM)
        return emb

    def test_retrieve_calls_rpc_and_returns_chunks(self, monkeypatch):
        rpc_response = MagicMock()
        rpc_response.data = [
            {"id": "nvda_hbm_001", "topic": "NVDA → HBM", "body": "...",
             "related_tickers": ["NVDA", "000660"], "sectors": ["semiconductor"],
             "similarity": 0.91},
            {"id": "sox_index_001", "topic": "SOX 동조", "body": "...",
             "related_tickers": ["^SOX"], "sectors": ["semiconductor"],
             "similarity": 0.83},
        ]
        rpc_call = MagicMock(return_value=MagicMock(execute=lambda: rpc_response))
        sb = MagicMock()
        sb.rpc = rpc_call
        monkeypatch.setattr("cognition.rag.retriever.get_admin_client", lambda: sb)

        result = asyncio.run(retrieve(
            "Nvidia 상승이 한국 반도체에 미치는 영향",
            ticker="000660", top_k=3,
            embedder=self._mock_embedder(),
        ))

        assert len(result) == 2
        assert result[0].id == "nvda_hbm_001"
        assert result[0].similarity == pytest.approx(0.91)
        # RPC called with expected params
        args, _ = rpc_call.call_args
        assert args[0] == "match_rag_chunks"
        assert args[1]["match_count"] == 3
        assert args[1]["filter_tickers"] == ["000660"]

    def test_no_ticker_filter(self, monkeypatch):
        rpc_response = MagicMock()
        rpc_response.data = []
        sb = MagicMock()
        sb.rpc = MagicMock(return_value=MagicMock(execute=lambda: rpc_response))
        monkeypatch.setattr("cognition.rag.retriever.get_admin_client", lambda: sb)

        asyncio.run(retrieve("any query", embedder=self._mock_embedder()))
        params = sb.rpc.call_args[0][1]
        assert params["filter_tickers"] is None
        assert params["filter_sectors"] is None
