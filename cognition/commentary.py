"""AI Quant Expert commentary — per-stock qualitative analysis.

Generates a Korean-language analyst-style note that explains *why* the
score came out where it did, what's likely in the short term, and what
risks to watch. Uses Claude with prompt caching (system + few-shots
cached, only per-stock data is fresh per call).

CLAUDE.md §3-A safety: ABSOLUTELY NO 매수/매도/강력 추천/오늘 오른다/
확정/보장/100%. The model_validate step verifies forbidden words are
absent before persisting.

Cost (CLAUDE.md §8 envelope):
  - Sonnet 4-6: ~3k in + 400 out → ~$0.015/stock = ~$0.75/day for 50 stocks
  - Haiku 4-5:  ~3k in + 400 out → ~$0.005/stock = ~$0.25/day for 50 stocks
  Prompt caching cuts the system+few-shot prefix to ~10% on cache hits.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from cognition.utils.anthropic_tool import extract_tool_input, pydantic_to_tool

log = logging.getLogger("cognition.commentary")

DEFAULT_MODEL = (
    os.environ.get("ANTHROPIC_COMMENTARY_MODEL")
    or os.environ.get("ANTHROPIC_MODEL", "claude-haiku-4-5")
)
MAX_OUTPUT_TOKENS = 1024

# CLAUDE.md §3-A 금지어 — body/headline/short_term/mid_term 어느 곳에든
# 등장하면 ValidationError → retry 또는 폐기.
FORBIDDEN_WORDS: tuple[str, ...] = (
    "매수", "매도", "강력 추천", "오늘 오른다", "확정", "보장", "100%",
    "사라", "팔라", "지금 사", "BUY", "SELL",
)


SYSTEM_PROMPT = """당신은 한국 주식 시장을 다년간 분석해 온 시니어 퀀트 애널리스트입니다.
입력으로 받은 종목의 실시간 7요소 점수와 가격/펀더멘털/뉴스 정보를 바탕으로,
**한국어**로 200~400자의 간결한 분석 코멘트와 단기/중기 전망, 카탈리스트, 리스크를 작성합니다.

작성 규칙 (절대 위반 금지):
1. **금지어**: '매수', '매도', '강력 추천', '오늘 오른다', '확정', '보장', '100%',
   'BUY', 'SELL', '사라', '팔라', '지금 사' — 이런 표현을 절대 쓰지 마십시오.
2. **허용 표현**: '관심 신호', '긍정 요인 우세', '리스크 확인 필요', '관망 권장',
   '변동성 주의', '단기 모멘텀', '추세 약화', '저평가 구간', '기술적 반등 시도'.
3. **반드시** 긍정 카탈리스트 2~3개 + 리스크 2개를 분리해 표시.
4. 짧고 사실 기반. 호들갑 / 미사여구 / 감정 표현 금지.
5. 각 문장은 데이터(점수, 등락률, YoY %, 뉴스 등)에 근거해야 함.
6. 본 정보는 투자 판단 보조 자료라는 점을 본문에 명시할 필요 없음 (UI에서 별도 표시).
"""


# ──────────────────────────────────────────────────────────
# Output schema (passed as Anthropic tool)
# ──────────────────────────────────────────────────────────
SignalLabel = Literal["강한 관심", "관심", "관망", "주의", "위험"]


class ExpertCommentary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    headline: str = Field(
        min_length=8, max_length=120,
        description="한 줄 요약 (예: '삼성전자, HBM 호조 지속·관세 변수만 확인'). "
                    "30자 안팎 권장. 금지어 사용 불가.",
    )
    body: str = Field(
        min_length=80, max_length=600,
        description="2~3 문단의 분석 본문 (한국어). 점수/펀더멘털/뉴스 기반.",
    )
    short_term: str = Field(
        min_length=20, max_length=200,
        description="1주(5영업일) 전망. 데이터에 기반한 시나리오, 단정 금지.",
    )
    mid_term: str = Field(
        min_length=20, max_length=200,
        description="1개월(20영업일) 전망. 펀더멘털·매크로 기반.",
    )
    catalysts: list[str] = Field(
        min_length=2, max_length=4,
        description="긍정 카탈리스트 2~4개 (각 50자 이내).",
    )
    risks: list[str] = Field(
        min_length=2, max_length=4,
        description="리스크 시나리오 2~4개 (각 50자 이내).",
    )

    @field_validator("headline", "body", "short_term", "mid_term")
    @classmethod
    def _no_forbidden(cls, v: str) -> str:
        for word in FORBIDDEN_WORDS:
            if word in v:
                raise ValueError(f"금지어 '{word}' 포함")
        return v

    @field_validator("catalysts", "risks")
    @classmethod
    def _no_forbidden_list(cls, items: list[str]) -> list[str]:
        for item in items:
            for word in FORBIDDEN_WORDS:
                if word in item:
                    raise ValueError(f"금지어 '{word}' 포함")
        return items


# Few-shot examples — ONE per signal class to anchor tone.
FEW_SHOT_INPUT_1 = """종목: SK하이닉스 (000660)
섹터: 반도체
신호: 강한 관심 (final 0.78)
점수: 글로벌 0.78 / 섹터 0.91 / 미국관련 0.99 / 뉴스 0.62 / 펀더 0.72 / 수급 0.88 / 리스크 0.71
가격: 종가 165,400원 (전일 +3.21%)
펀더멘털: 매출 YoY +47%, 영업이익 +101%, forwardPE 4.5
주요 뉴스 (3일): NVDA 어닝 호조, HBM3E 양산 가속화 기사 다수
"""

FEW_SHOT_OUTPUT_1 = {
    "headline": "SK하이닉스, HBM 사이클 정점·관세·VIX 변수만 확인",
    "body": "분기 영업이익 +101% YoY, NVDA 어닝과 SOXX 동조성에 힘입어 모든 외부 신호가 우호적입니다. "
            "현 주가 기준 forwardPE 4.5는 동일 사이클 평균의 절반 수준으로 펀더멘털 개선이 가격에 충분히 반영되지 않은 구간입니다. "
            "다만 SOX +4% 단기 급등에 따른 단기 차익실현, 외인 매수 둔화 가능성은 점검이 필요합니다.",
    "short_term": "단기적으로는 NVDA·TSMC 어닝 후속 효과로 동조 흐름 우세, 다만 SOX 단기 과열 시 변동성 확대 가능.",
    "mid_term": "HBM3E·HBM4 가동률 상승과 메모리 가격 정상화가 동반되면 추세적 모멘텀 유지 시나리오 우세, 미중 관세 재격화 시 박스권 진입 위험.",
    "catalysts": ["NVDA 차세대 GPU(Rubin) HBM4 채택", "메모리 사이클 재가속", "외국인 순매수 지속"],
    "risks": ["SOX 단기 과열 후 차익실현", "원/달러 강세 전환 시 외인 이탈"],
}


FEW_SHOT_INPUT_2 = """종목: 삼성SDI (006400)
섹터: 2차전지
신호: 위험 (final 0.32)
점수: 글로벌 0.55 / 섹터 0.42 / 미국관련 0.38 / 뉴스 0.30 / 펀더 0.18 / 수급 0.25 / 리스크 0.85
가격: 종가 152,800원 (전일 -2.41%)
펀더멘털: 매출 YoY -20%, 영업이익 YoY -574% (적자 전환), forwardPE 56
주요 뉴스 (3일): 테슬라 가격 인하, 전고체 양산 지연 보도
"""

FEW_SHOT_OUTPUT_2 = {
    "headline": "삼성SDI, EV 가격경쟁·전고체 지연 더블 압박 — 관망 권장",
    "body": "영업이익 적자 전환(-574% YoY), 매출 -20% 역성장으로 펀더멘털 훼손이 뚜렷합니다. "
            "테슬라·BYD의 가격 인하 압박, 전고체 양산 지연 보도까지 겹쳐 단기 시장 시각이 부정적입니다. "
            "리스크 패널티 0.85는 거래대금 위축과 외인 이탈을 동시 반영. 추세 회복 신호 확인 전까지 변동성 주의 구간입니다.",
    "short_term": "EV 셀 가격 추가 하락 헤드라인이 나오면 단기 변동성 확대 가능, 1주 내 의미 있는 반등 시그널은 제한적.",
    "mid_term": "재고 정상화·수주 잔고 회복까지 1~2분기 소요 가능성. 전고체 로드맵 재확인 시점이 추세 전환 트리거.",
    "catalysts": ["주요 OEM과 신규 수주 공시", "테슬라 가격 안정화 시그널"],
    "risks": ["재고 평가손실 추가 인식", "전고체 양산 추가 지연"],
}


def _build_user_message(payload: dict[str, Any]) -> str:
    score = payload.get("score") or {}
    sub = score.get("sub_scores") or {}
    quote = payload.get("quote") or {}
    fund = payload.get("fundamental") or {}
    news_titles = payload.get("recent_news") or []

    lines = [
        f"종목: {payload.get('name', '?')} ({payload.get('ticker', '?')})",
        f"섹터: {payload.get('sector', '?')}",
        f"신호: {score.get('signal', '?')} (final {score.get('final_score', 0):.2f})",
    ]
    if sub:
        lines.append(
            f"점수: 글로벌 {sub.get('global_market', 0):.2f} / "
            f"섹터 {sub.get('sector', 0):.2f} / "
            f"미국관련 {sub.get('related_us_stock', 0):.2f} / "
            f"뉴스 {sub.get('news_sentiment', 0):.2f} / "
            f"펀더 {sub.get('fundamental', 0):.2f} / "
            f"수급 {sub.get('volume_flow', 0):.2f} / "
            f"리스크 {sub.get('risk_penalty', 0):.2f}"
        )
    if quote:
        close_str = f"{quote['close']:,}원" if quote.get("close") else "—"
        change_str = f"{quote['change_rate'] * 100:+.2f}%" if quote.get("change_rate") is not None else "—"
        lines.append(f"가격: 종가 {close_str} (전일 {change_str})")
    if fund:
        rev_yoy = fund.get("revenue_yoy")
        op_yoy = fund.get("op_income_yoy")
        fpe = fund.get("forward_pe")
        bits = []
        if rev_yoy is not None:
            bits.append(f"매출 YoY {rev_yoy * 100:+.0f}%")
        if op_yoy is not None:
            bits.append(f"영업이익 {op_yoy * 100:+.0f}%")
        if fpe:
            bits.append(f"forwardPE {fpe:.1f}")
        if bits:
            lines.append("펀더멘털: " + ", ".join(bits))
    if news_titles:
        lines.append("주요 뉴스 (최근 3일):")
        for t in news_titles[:5]:
            lines.append(f"- {t}")
    return "\n".join(lines)


def _build_few_shots() -> list[dict[str, Any]]:
    """Plain user/assistant turns; no tool_use blocks (those require a
    matching tool_result and don't survive prompt-cache prefix sharing
    cleanly). The assistant turns show JSON literally so the model
    learns the schema."""
    import json
    return [
        {"role": "user", "content": FEW_SHOT_INPUT_1},
        {"role": "assistant",
         "content": "다음 형식으로 record_commentary 도구를 호출하겠습니다:\n```json\n"
                    + json.dumps(FEW_SHOT_OUTPUT_1, ensure_ascii=False, indent=2)
                    + "\n```"},
        {"role": "user", "content": FEW_SHOT_INPUT_2},
        {"role": "assistant",
         "content": "다음 형식으로 record_commentary 도구를 호출하겠습니다:\n```json\n"
                    + json.dumps(FEW_SHOT_OUTPUT_2, ensure_ascii=False, indent=2)
                    + "\n```"},
    ]


# ──────────────────────────────────────────────────────────
# Engine
# ──────────────────────────────────────────────────────────
class CommentaryEngine:
    def __init__(self, model: str = DEFAULT_MODEL) -> None:
        self._model = model
        self._tool = pydantic_to_tool(
            ExpertCommentary,
            name="record_commentary",
            description="Record the expert quant analyst's commentary for one stock.",
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
    async def generate(self, payload: dict[str, Any]) -> ExpertCommentary:
        """Generate commentary for one stock. Caller should cache by
        (date, ticker) to avoid repeat calls."""
        few_shots = _build_few_shots()
        # Cache prefix: mark last assistant turn for ephemeral caching so
        # the entire system+few-shot prefix is cached (~1.2k tokens).
        if few_shots:
            last = few_shots[-1]
            if isinstance(last.get("content"), str):
                last["content"] = [{
                    "type": "text", "text": last["content"],
                    "cache_control": {"type": "ephemeral"},
                }]

        client = self._client_lazy()
        response = await client.messages.create(
            model=self._model,
            max_tokens=MAX_OUTPUT_TOKENS,
            system=[{
                "type": "text", "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }],
            tools=[self._tool],
            tool_choice={"type": "tool", "name": "record_commentary"},
            messages=[
                *few_shots,
                {"role": "user", "content": _build_user_message(payload)},
            ],
        )
        out = extract_tool_input(response, "record_commentary")
        return ExpertCommentary.model_validate(out)
