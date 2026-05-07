"""Daily Korean-language market brief — covers the whole watchlist on /dashboard.

Distinct from cognition/commentary.py which is per-stock. This brief
takes a market-wide view: global tape + sector flows + top movers +
risk watch + macro one-liner.

Same safety guard as report.py / commentary.py: CLAUDE.md §3-A
forbidden words rejected at validation time.
"""
from __future__ import annotations

import logging
import os
from datetime import date as Date
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from cognition.utils.anthropic_tool import extract_tool_input, pydantic_to_tool

log = logging.getLogger("cognition.market_brief")

DEFAULT_MODEL = (
    os.environ.get("ANTHROPIC_BRIEF_MODEL")
    or os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
)
MAX_OUTPUT_TOKENS = 1500

FORBIDDEN_WORDS: tuple[str, ...] = (
    "매수", "매도", "강력 추천", "오늘 오른다", "확정", "보장", "100%",
    "사라", "팔라", "지금 사", "BUY", "SELL",
)

SYSTEM_PROMPT = """당신은 한국 주식 시장을 다년간 분석해 온 시니어 시장 전략가입니다.
입력으로 받은 글로벌 시장 / 섹터 / 상위 관심 종목 / 거시 지표 데이터를 종합하여,
**한국어**로 시장 전체에 대한 일일 브리핑을 작성합니다.

작성 규칙 (절대 위반 금지):
1. **금지어**: '매수', '매도', '강력 추천', '오늘 오른다', '확정', '보장', '100%',
   'BUY', 'SELL', '사라', '팔라', '지금 사' — 이 표현을 절대 쓰지 마십시오.
2. 허용 표현: '관심 신호', '긍정 요인 우세', '리스크 확인 필요', '관망 권장',
   '변동성 주의', '단기 모멘텀', '추세 약화', '거시 우호', '거시 부담'.
3. headline 한 줄 (40자 이내), body 본문 2~3 단락 (300~500자).
4. sector_view: 5개 섹터 흐름을 한 단락으로 요약.
5. top_picks: 강한 관심 / 관심 신호 종목 중 흥미로운 케이스 3~5개 (각 50자 이내).
6. risk_watch: 위험 신호 종목 또는 매크로 위험 요인 2~3개 (각 50자 이내).
7. macro_summary: USDKRW, 10Y UST, VIX 등 거시 한 단락.
8. 사실/데이터 근거 우선. 호들갑/감정 표현 금지.
"""


class MarketBrief(BaseModel):
    model_config = ConfigDict(extra="forbid")

    headline: str = Field(min_length=8, max_length=120)
    body: str = Field(min_length=100, max_length=800)
    sector_view: str = Field(min_length=20, max_length=400)
    top_picks: list[str] = Field(min_length=2, max_length=6)
    risk_watch: list[str] = Field(min_length=1, max_length=4)
    macro_summary: str = Field(min_length=20, max_length=400)

    @field_validator("headline", "body", "sector_view", "macro_summary")
    @classmethod
    def _no_forbidden(cls, v: str) -> str:
        for w in FORBIDDEN_WORDS:
            if w in v:
                raise ValueError(f"금지어 '{w}' 포함")
        return v

    @field_validator("top_picks", "risk_watch")
    @classmethod
    def _no_forbidden_list(cls, items: list[str]) -> list[str]:
        for it in items:
            for w in FORBIDDEN_WORDS:
                if w in it:
                    raise ValueError(f"금지어 '{w}' 포함")
        return items


def _build_user_message(payload: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append(f"기준일: {payload.get('date', '?')}")

    g = payload.get("global") or []
    if g:
        bits = [f"{x['symbol']} {x.get('change_rate', 0) * 100:+.2f}%"
                for x in g if x.get("change_rate") is not None]
        lines.append(f"글로벌: {' / '.join(bits)}")

    sectors = payload.get("sectors") or []
    if sectors:
        bits = [f"{s['name']} {s['avg_score']:.2f}"
                for s in sectors]
        lines.append(f"섹터 온도: {' / '.join(bits)}")

    macro = payload.get("macro") or {}
    if macro:
        bits = [f"{k} {v * 100:+.2f}%" if v is not None else f"{k} —"
                for k, v in macro.items()]
        lines.append(f"매크로: {' / '.join(bits)}")

    top = payload.get("top_signals") or []
    if top:
        lines.append("상위 신호:")
        for t in top[:8]:
            lines.append(
                f"- {t.get('signal', '')} | {t.get('name', '')} ({t.get('ticker', '')}) "
                f"final {t.get('final_score', 0):.2f} · {t.get('sector', '')}"
            )

    risks = payload.get("risk_signals") or []
    if risks:
        lines.append("주의/위험 신호:")
        for r in risks[:6]:
            lines.append(
                f"- {r.get('signal', '')} | {r.get('name', '')} ({r.get('ticker', '')}) "
                f"final {r.get('final_score', 0):.2f}"
            )
    return "\n".join(lines)


class MarketBriefEngine:
    def __init__(self, model: str = DEFAULT_MODEL) -> None:
        self._model = model
        self._tool = pydantic_to_tool(
            MarketBrief, name="record_market_brief",
            description="Record the daily Korean-language market brief.",
        )
        self._client = None

    def _client_lazy(self):
        if self._client is None:
            from anthropic import AsyncAnthropic
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                raise RuntimeError("ANTHROPIC_API_KEY not set")
            self._client = AsyncAnthropic(api_key=api_key)
        return self._client

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=1, max=8),
        retry=retry_if_exception_type((RuntimeError, ValueError)),
        reraise=True,
    )
    async def generate(self, payload: dict[str, Any]) -> MarketBrief:
        client = self._client_lazy()
        response = await client.messages.create(
            model=self._model,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=[{
                "type": "text", "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=[self._tool],
            tool_choice={"type": "tool", "name": "record_market_brief"},
            messages=[{"role": "user", "content": _build_user_message(payload)}],
        )
        out = extract_tool_input(response, "record_market_brief")
        return MarketBrief.model_validate(out)
