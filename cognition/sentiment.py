"""SentimentEngine — Claude-based news sentiment with caching + cost cap.

Pipeline contract:
  refinery → news_items rows with sentiment_*=NULL, embedding=NULL
  cognition.sentiment.score_batch(date) →
      reads news_items WHERE date=date AND sentiment_score IS NULL
      for each: cached LLM call + parallel OpenAI embed
      writes sentiment_score, sentiment_label, importance, embedding back

CLAUDE.md §C requirements satisfied:
  - system prompt + 3 few-shot examples + structured output (Anthropic tool)
  - same (date, title) hashed cache key — no double billing
  - retry 2x on LLM/parsing failure, then skip + log (no silent fix)
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from datetime import date as Date
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from cognition.__schemas__.sentiment import SentimentResult
from cognition.embedder import Embedder
from cognition.utils.anthropic_tool import extract_tool_input, pydantic_to_tool
from cognition.utils.cache import Cache, make_cache
from cognition.utils.cost_tracker import CostTracker, DailyCapExceeded
from db.supabase_client import get_admin_client

if TYPE_CHECKING:
    from anthropic import AsyncAnthropic

log = logging.getLogger("cognition.sentiment")

DEFAULT_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
SENTIMENT_CONCURRENCY = 5
CACHE_TTL_SECONDS = 7 * 24 * 3600       # 7 days
MAX_INPUT_TOKENS = 4000
MAX_OUTPUT_TOKENS = 500
NEWS_BODY_TRUNCATE_CHARS = 6000         # rough proxy for ~4k tokens

SYSTEM_PROMPT = (
    "당신은 한국 주식시장 투자자 관점에서 글로벌·국내 뉴스의 감성을 분석합니다. "
    "각 기사를 읽고 '한국 관심종목에 미치는 단기 영향(다음 거래일)'을 기준으로 "
    "0.0(매우 부정) ~ 1.0(매우 긍정) 점수와 5단계 라벨을 할당하세요. "
    "절대 매매 권유나 가격 예측을 하지 말고, 사실에 근거한 영향 평가만 하세요. "
    "금지어: '매수', '매도', '강력 추천', '오늘 오른다', '확정', '보장', '100%'."
)

FEW_SHOTS: list[dict[str, str]] = [
    {
        "title": "Nvidia, AI 칩 수요 폭증으로 분기 매출 사상 최대 (전년 동기 +112%)",
        "body": "Nvidia가 AI 가속기 수요 폭증으로 분기 매출 300억 달러를 돌파했다고 발표. "
                "데이터센터 부문이 전체의 87%를 차지. 향후 분기 가이던스도 컨센서스 상회.",
        "expected_label": "very_positive",
        "expected_score": "0.92",
    },
    {
        "title": "삼성전자, 정기 임원 인사 발표",
        "body": "삼성전자가 연말 정기 임원 인사를 단행했다. DS부문장은 유임, "
                "MX·VD부문은 일부 조직 개편이 있었지만 사업 전략에는 큰 변화가 없을 것으로 보인다.",
        "expected_label": "neutral",
        "expected_score": "0.50",
    },
    {
        "title": "美 연준, 금리 동결... 시장의 인하 기대 후퇴",
        "body": "연준이 기준금리를 5.25-5.50%로 동결하며 인플레이션 재확인 발언. "
                "파월 의장은 '추가 데이터 확인 필요' 언급. 시장의 12월 인하 확률 60%→25%로 하락.",
        "expected_label": "negative",
        "expected_score": "0.25",
    },
]


def _cache_key(date: Date, title: str) -> str:
    h = hashlib.sha256(f"{date.isoformat()}|{title}".encode()).hexdigest()[:24]
    return f"sentiment:{DEFAULT_MODEL}:{h}"


def _build_user_message(title: str, body: str | None, related: list[str]) -> str:
    body_txt = (body or "")[:NEWS_BODY_TRUNCATE_CHARS]
    related_txt = ", ".join(related) if related else "(미지정)"
    return (
        f"[제목] {title}\n"
        f"[관련 종목] {related_txt}\n"
        f"[본문]\n{body_txt}\n\n"
        "위 기사를 분석해 record_sentiment 도구를 호출하세요."
    )


def _build_few_shot_messages() -> list[dict[str, Any]]:
    """Return prefilled message turns demonstrating the tool calling format."""
    msgs: list[dict[str, Any]] = []
    for i, shot in enumerate(FEW_SHOTS):
        msgs.append({
            "role": "user",
            "content": _build_user_message(shot["title"], shot["body"], []),
        })
        msgs.append({
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": f"toolu_few_shot_{i}",
                "name": "record_sentiment",
                "input": {
                    "sentiment_score": float(shot["expected_score"]),
                    "sentiment_label": shot["expected_label"],
                    "related_symbols": [],
                    "importance": "medium",
                    "reasoning": "예시 응답 (학습용)",
                },
            }],
        })
        msgs.append({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": f"toolu_few_shot_{i}",
                "content": "OK",
            }],
        })
    return msgs


class SentimentEngine:
    def __init__(
        self,
        anthropic_client: AsyncAnthropic | None = None,
        embedder: Embedder | None = None,
        cache: Cache | None = None,
        model: str = DEFAULT_MODEL,
    ) -> None:
        self._client = anthropic_client
        self._embedder = embedder or Embedder(cache=cache)
        self._cache = cache or make_cache()
        self._cost = CostTracker(self._cache, model)
        self._model = model
        self._sem = asyncio.Semaphore(SENTIMENT_CONCURRENCY)
        self._tool = pydantic_to_tool(
            SentimentResult,
            name="record_sentiment",
            description="Record the sentiment analysis of a news article from a Korean "
                        "stock investor's perspective.",
        )

    def _ensure_client(self) -> AsyncAnthropic:
        if self._client is None:
            from anthropic import AsyncAnthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise RuntimeError("ANTHROPIC_API_KEY not set")
            self._client = AsyncAnthropic(api_key=api_key)
        return self._client

    # ──────────────────────────────────────────────────────
    # Single article — cache-first
    # ──────────────────────────────────────────────────────
    async def score_one(
        self,
        *,
        on_date: Date,
        title: str,
        body: str | None,
        related_symbols: list[str],
    ) -> SentimentResult:
        cache_key = _cache_key(on_date, title)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return SentimentResult.model_validate(cached)

        # Cost cap check before the call (raises DailyCapExceeded).
        if not self._cost.can_call(on_date):
            raise DailyCapExceeded(
                f"Refusing additional LLM call for {on_date.isoformat()}"
            )

        result = await self._call_llm(title, body or "", related_symbols)
        self._cost.increment(on_date)
        self._cache.set(cache_key, result.model_dump(), ttl_seconds=CACHE_TTL_SECONDS)
        return result

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type((ValidationError, ValueError, RuntimeError)),
        reraise=True,
    )
    async def _call_llm(
        self, title: str, body: str, related: list[str],
    ) -> SentimentResult:
        async with self._sem:
            client = self._ensure_client()
            response = await client.messages.create(
                model=self._model,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=SYSTEM_PROMPT,
                tools=[self._tool],
                tool_choice={"type": "tool", "name": "record_sentiment"},
                messages=[
                    *_build_few_shot_messages(),
                    {"role": "user", "content": _build_user_message(title, body, related)},
                ],
            )
        payload = extract_tool_input(response, "record_sentiment")
        return SentimentResult.model_validate(payload)

    # ──────────────────────────────────────────────────────
    # Batch — read DB → score + embed → write back
    # ──────────────────────────────────────────────────────
    async def score_batch(self, on_date: Date) -> dict[str, int]:
        """Process all unscored news_items for `on_date`. Returns counts."""
        sb = get_admin_client()
        rows = (
            sb.table("news_items")
              .select("id, title, body, related_symbols")
              .eq("date", on_date.isoformat())
              .is_("sentiment_score", "null")
              .execute()
              .data
        ) or []
        log.info("score_batch: %d unscored news items for %s", len(rows), on_date)

        succeeded = 0
        skipped_cap = 0
        failed = 0

        for row in rows:
            try:
                result = await self.score_one(
                    on_date=on_date,
                    title=row["title"],
                    body=row.get("body"),
                    related_symbols=row.get("related_symbols") or [],
                )
                embedding_input = (row["title"] + "\n" + (row.get("body") or ""))[:8000]
                embedding = await self._embedder.embed(embedding_input)

                sb.table("news_items").update({
                    "sentiment_score": result.sentiment_score,
                    "sentiment_label": result.sentiment_label,
                    "importance":      result.importance,
                    "embedding":       embedding,
                }).eq("id", row["id"]).execute()
                succeeded += 1
            except DailyCapExceeded:
                log.warning("Daily LLM cap hit; aborting batch (%d processed so far)", succeeded)
                skipped_cap = len(rows) - succeeded
                break
            except Exception as exc:
                log.warning("news id=%s failed (%s: %s) — skipping",
                            row["id"], type(exc).__name__, exc)
                failed += 1

        log.info("score_batch done — succeeded=%d failed=%d skipped_by_cap=%d",
                 succeeded, failed, skipped_cap)
        return {"succeeded": succeeded, "failed": failed, "skipped_by_cap": skipped_cap}
