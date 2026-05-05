"""Cognition.sentiment — cache, retry, daily cap, embedding, batch."""
from __future__ import annotations

import asyncio
from datetime import date as Date
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from cognition.__schemas__.sentiment import SentimentResult
from cognition.embedder import EMBEDDING_DIM, Embedder
from cognition.sentiment import SentimentEngine, _cache_key
from cognition.utils.cache import InMemoryCache, make_cache
from cognition.utils.cost_tracker import CostTracker, DailyCapExceeded


# ───────────────────────────────────────────────────────────
# SentimentResult schema
# ───────────────────────────────────────────────────────────
class TestSentimentResultSchema:
    def test_valid(self):
        r = SentimentResult(
            sentiment_score=0.85, sentiment_label="positive",
            related_symbols=["NVDA"], importance="high",
            reasoning="긍정 요인 우세, 매출 가이던스 상회.",
        )
        assert r.sentiment_score == 0.85

    def test_score_out_of_range_rejected(self):
        with pytest.raises(ValidationError):
            SentimentResult(
                sentiment_score=1.5, sentiment_label="positive",
                importance="high", reasoning="x",
            )

    def test_unknown_label_rejected(self):
        with pytest.raises(ValidationError):
            SentimentResult(
                sentiment_score=0.5, sentiment_label="bullish",   # not in 5-bucket enum
                importance="high", reasoning="x",
            )


# ───────────────────────────────────────────────────────────
# Cache backends
# ───────────────────────────────────────────────────────────
class TestInMemoryCache:
    def test_set_get(self):
        c = InMemoryCache()
        c.set("k", {"a": 1}, ttl_seconds=60)
        assert c.get("k") == {"a": 1}

    def test_miss(self):
        assert InMemoryCache().get("missing") is None

    def test_expiry(self):
        c = InMemoryCache()
        c.set("k", "v", ttl_seconds=1)
        # Force expiry by manipulating internal store.
        c._store["k"] = (0.0, "v")
        assert c.get("k") is None

    def test_make_cache_falls_back_when_no_redis_url(self, monkeypatch):
        monkeypatch.delenv("REDIS_URL", raising=False)
        assert isinstance(make_cache(), InMemoryCache)

    def test_make_cache_falls_back_when_redis_unreachable(self, monkeypatch):
        monkeypatch.setenv("REDIS_URL", "redis://nonexistent-host:6379/0")
        # Should fallback to in-memory rather than crash.
        cache = make_cache()
        assert isinstance(cache, InMemoryCache)


# ───────────────────────────────────────────────────────────
# Cost tracker
# ───────────────────────────────────────────────────────────
class TestCostTracker:
    def test_increments_until_cap(self, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "3")
        tracker = CostTracker(InMemoryCache(), model="claude-test")
        d = Date(2026, 5, 4)

        assert tracker.current(d) == 0
        assert tracker.can_call(d)
        tracker.increment(d)
        tracker.increment(d)
        tracker.increment(d)
        assert tracker.current(d) == 3
        assert not tracker.can_call(d)
        with pytest.raises(DailyCapExceeded):
            tracker.increment(d)

    def test_separate_dates_independent(self, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "2")
        tracker = CostTracker(InMemoryCache(), model="claude-test")
        tracker.increment(Date(2026, 5, 4))
        tracker.increment(Date(2026, 5, 5))
        tracker.increment(Date(2026, 5, 5))
        assert tracker.current(Date(2026, 5, 4)) == 1
        assert tracker.current(Date(2026, 5, 5)) == 2


# ───────────────────────────────────────────────────────────
# SentimentEngine — caching + retry + cap
# ───────────────────────────────────────────────────────────
def _fake_anthropic_response(score: float = 0.85, label: str = "positive"):
    """Build a MagicMock that mimics anthropic.types.Message with a tool_use block."""
    block = MagicMock()
    block.type = "tool_use"
    block.name = "record_sentiment"
    block.input = {
        "sentiment_score": score,
        "sentiment_label": label,
        "related_symbols": ["NVDA"],
        "importance": "high",
        "reasoning": "긍정 신호 우세, 단기 모멘텀 양호.",
    }
    response = MagicMock()
    response.content = [block]
    return response


class TestSentimentEngineCaching:
    def _engine(self, cache, anthropic_client):
        return SentimentEngine(
            anthropic_client=anthropic_client,
            embedder=MagicMock(),
            cache=cache,
            model="claude-test",
        )

    def test_cache_hit_skips_api(self, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "100")
        cache = InMemoryCache()
        client = MagicMock()
        client.messages = MagicMock()
        client.messages.create = AsyncMock(return_value=_fake_anthropic_response())

        engine = self._engine(cache, client)

        async def run():
            r1 = await engine.score_one(
                on_date=Date(2026, 5, 4),
                title="Nvidia 사상 최대 매출",
                body="...", related_symbols=["NVDA"],
            )
            r2 = await engine.score_one(
                on_date=Date(2026, 5, 4),
                title="Nvidia 사상 최대 매출",   # same title → cache hit
                body="...different body", related_symbols=["NVDA"],
            )
            return r1, r2

        r1, r2 = asyncio.run(run())
        assert r1.sentiment_score == r2.sentiment_score
        assert client.messages.create.call_count == 1   # API called once

    def test_cap_reached_raises(self, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "0")
        cache = InMemoryCache()
        client = MagicMock()
        engine = self._engine(cache, client)

        async def run():
            await engine.score_one(
                on_date=Date(2026, 5, 4), title="x", body="x", related_symbols=[],
            )

        with pytest.raises(DailyCapExceeded):
            asyncio.run(run())

    def test_validation_error_triggers_retry_then_succeeds(self, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "100")
        cache = InMemoryCache()
        client = MagicMock()
        # First call returns invalid score (>1), second returns valid.
        client.messages.create = AsyncMock(side_effect=[
            _fake_anthropic_response(score=2.5),     # invalid → retry
            _fake_anthropic_response(score=0.7),     # valid
        ])
        engine = self._engine(cache, client)

        async def run():
            return await engine.score_one(
                on_date=Date(2026, 5, 4), title="z", body="z", related_symbols=[],
            )

        result = asyncio.run(run())
        assert result.sentiment_score == 0.7
        assert client.messages.create.call_count == 2

    def test_retry_exhaustion_raises(self, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "100")
        cache = InMemoryCache()
        client = MagicMock()
        client.messages.create = AsyncMock(
            return_value=_fake_anthropic_response(score=2.5),     # always invalid
        )
        engine = self._engine(cache, client)

        async def run():
            await engine.score_one(
                on_date=Date(2026, 5, 4), title="z", body="z", related_symbols=[],
            )

        with pytest.raises(ValidationError):
            asyncio.run(run())
        assert client.messages.create.call_count == 3   # initial + 2 retries


# ───────────────────────────────────────────────────────────
# Cache key determinism
# ───────────────────────────────────────────────────────────
class TestCacheKey:
    def test_same_date_same_title_same_key(self):
        k1 = _cache_key(Date(2026, 5, 4), "Same headline")
        k2 = _cache_key(Date(2026, 5, 4), "Same headline")
        assert k1 == k2

    def test_different_date_different_key(self):
        k1 = _cache_key(Date(2026, 5, 4), "x")
        k2 = _cache_key(Date(2026, 5, 5), "x")
        assert k1 != k2

    def test_different_title_different_key(self):
        k1 = _cache_key(Date(2026, 5, 4), "a")
        k2 = _cache_key(Date(2026, 5, 4), "b")
        assert k1 != k2


# ───────────────────────────────────────────────────────────
# Embedder
# ───────────────────────────────────────────────────────────
class TestEmbedder:
    def test_empty_text_rejected(self):
        emb = Embedder(client=MagicMock(), cache=InMemoryCache())
        with pytest.raises(ValueError):
            asyncio.run(emb.embed(""))

    def test_cache_hit_skips_api(self):
        cache = InMemoryCache()
        client = MagicMock()
        client.embeddings = MagicMock()
        # Build a fake embedding response.
        fake_embedding = [0.01] * EMBEDDING_DIM
        emb_response = MagicMock()
        emb_response.data = [MagicMock(embedding=fake_embedding)]
        client.embeddings.create = AsyncMock(return_value=emb_response)

        embedder = Embedder(client=client, cache=cache)

        async def run():
            v1 = await embedder.embed("identical text")
            v2 = await embedder.embed("identical text")
            return v1, v2

        v1, v2 = asyncio.run(run())
        assert len(v1) == EMBEDDING_DIM
        assert v1 == v2
        assert client.embeddings.create.call_count == 1

    def test_dim_mismatch_raises(self):
        cache = InMemoryCache()
        client = MagicMock()
        emb_response = MagicMock()
        emb_response.data = [MagicMock(embedding=[0.0] * 100)]      # wrong dim
        client.embeddings = MagicMock()
        client.embeddings.create = AsyncMock(return_value=emb_response)

        embedder = Embedder(client=client, cache=cache)
        with pytest.raises(RuntimeError, match="Unexpected embedding dim"):
            asyncio.run(embedder.embed("x"))
