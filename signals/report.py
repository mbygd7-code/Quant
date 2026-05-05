"""ReportGenerator — Claude-generated narrative + forbidden-word post-validation.

Pipeline contract:
  cognition.scorer wrote ai_scores rows with rationale_json = stub
  ↓
  signals.report.ReportGenerator.generate_one(ticker, on_date) →
      reads AIScore + top-3 news + top-3 RAG chunks
      forced tool_use of `record_report`
      validates output (no forbidden words)
      retries up to 2x on validation/parse failure
      returns StockReport with disclaimer appended
  ↓
  signals.preview_report aggregates 50 reports into a daily markdown
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from datetime import date as Date
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from cognition.embedder import Embedder
from cognition.rag.retriever import RetrievedChunk, retrieve
from cognition.utils.anthropic_tool import extract_tool_input, pydantic_to_tool
from cognition.utils.cache import Cache, make_cache
from cognition.utils.cost_tracker import CostTracker, DailyCapExceeded
from db.supabase_client import get_admin_client
from signals.__schemas__.report import (
    ForbiddenWordError,
    ReportSkipped,
    StockReport,
    validate_report,
    with_disclaimer,
)

if TYPE_CHECKING:
    from anthropic import AsyncAnthropic

log = logging.getLogger("signals.report")

DEFAULT_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-7")
REPORT_CONCURRENCY = 3                       # longer outputs than sentiment
CACHE_TTL_SECONDS = 24 * 3600                # 1 report per (ticker, date)
MAX_OUTPUT_TOKENS = 1200
NEWS_BODY_TRUNCATE_CHARS = 220
RAG_BODY_TRUNCATE_CHARS = 250
MAX_VALIDATION_RETRIES = 2

SYSTEM_PROMPT = """\
당신은 한국 주식시장의 투자 판단을 돕는 보조 분석가입니다. 사용자에게 매매 권유를
하는 것이 아니라, 시장 데이터·뉴스·관련 미국 종목 동향을 종합해 '관심 신호'의
근거와 리스크를 객관적으로 정리합니다.

작성 규칙:
1. 절대 금지어 (한 번이라도 사용 시 응답 자체가 폐기됩니다):
   "매수", "매도", "강력 추천", "오늘 오른다", "확정", "보장", "100%"
2. 권장 표현:
   "관심 신호", "긍정 요인 우세", "리스크 확인 필요", "관망 권장", "변동성 주의",
   "수급 우호적", "단기 모멘텀 양호", "추격 매수 위험"
3. 사실 기반: 입력으로 받은 (a) 관련 미국 종목 동향, (b) 관련 뉴스, (c) 투자
   가설 RAG 청크에서 근거를 도출합니다. 입력에 없는 정보를 만들어내지 않습니다.
4. 가격 예측 금지: "오늘 N% 오른다" 같은 표현 금지. 대신 "긍정 요인이 우세하나
   장 초반 변동성 확인 필요" 같이 조건부로만 표현.
5. 출력 구조 (record_report 도구 강제 호출):
   - positive_factors: 정확히 3개. 각 1~2문장. 구체적 수치/뉴스 인용.
   - risk_factors: 정확히 2개. 각 1~2문장. 단기·구조적 리스크 분리.
   - comment: 2~3문장. 전체 종합 코멘트. 신호 등급에 부합하는 톤.

신호 등급별 톤 가이드:
  - 강한 관심: 다수 긍정 요인 정렬. 단 추격 매수 위험은 반드시 언급.
  - 관심:     긍정 요인 우세. 모니터링 권장.
  - 관망:     중립. 추가 신호 대기 권장.
  - 주의:     리스크 우세. 신중한 접근 권장.
  - 위험:     부정 요인 다수. 보수적 대응 권장.

기억하세요: 한 사용자가 이 정보를 보고 어떤 결정을 내릴지는 본인의 책임이며,
당신의 역할은 객관적 정보 정리입니다. 금지어 한 번이면 응답 폐기 → 재시도.
"""


# ──────────────────────────────────────────────────────────
# Few-shot examples — see Prompt 07 review (4 cases covering all 5 bands)
# ──────────────────────────────────────────────────────────
def _few_shot_strong_interest() -> tuple[str, dict]:
    user = (
        "[종목] SK하이닉스 (000660) · 섹터: 반도체\n"
        "[오늘 신호] 강한 관심 · 점수 0.82\n"
        "[sub-score] 글로벌 0.78, 섹터 0.81, 관련 미국 0.91, 뉴스 0.86, 펀더멘털 0.50, 수급 0.74, 리스크 0.35\n"
        "[관련 뉴스] 1. (0.92) Nvidia AI 칩 수요 폭증, 분기 매출 사상 최대\n"
        "            2. (0.85) HBM3E 8단 제품 양산 시작, 빅테크 인증 완료\n"
        "            3. (0.78) 외국인 5거래일 연속 순매수 (누적 4,200억)\n"
        "[관련 가설] 1. Nvidia 데이터센터 매출 호조 → 한국 HBM 공급망 수혜\n"
        "            2. DRAM/NAND 현물가격 사이클 → 메모리 종목 모멘텀\n"
        "            3. 필라델피아 반도체 지수(SOX) → 한국 반도체 동조"
    )
    output = {
        "positive_factors": [
            "Nvidia 데이터센터 매출 가이던스 상회 + HBM3E 8단 양산 시작 (감성 0.92, 0.85)로 글로벌 AI 사이클 직접 수혜",
            "관련 미국 종목 점수 0.91로 NVDA·AMD·MU 동반 강세 — 메모리 사이클 회복 신호",
            "외국인 5거래일 연속 순매수 누적 4,200억으로 수급 우호적",
        ],
        "risk_factors": [
            "전일까지 5거래일 연속 강세 → 장 초반 갭상승 시 단기 추격 매수 위험",
            "리스크 점수 0.35로 변동성 평균 대비 다소 높음. 美 국채금리·환율 동반 확인 필요",
        ],
        "comment": (
            "긍정 요인 우세이며 글로벌 AI 사이클·HBM 모멘텀이 정렬된 강한 관심 구간입니다. "
            "다만 단기 과열 가능성이 있어 갭상승 시 추격보다는 가격 안정 확인 후 접근이 권장됩니다."
        ),
    }
    return user, output


def _few_shot_neutral() -> tuple[str, dict]:
    user = (
        "[종목] 현대차 (005380) · 섹터: 자동차\n"
        "[오늘 신호] 관망 · 점수 0.56\n"
        "[sub-score] 글로벌 0.55, 섹터 0.48, 관련 미국 0.62, 뉴스 0.58, 펀더멘털 0.50, 수급 0.61, 리스크 0.40\n"
        "[관련 뉴스] 1. (0.72) USD/KRW 1450원 돌파 — 4월 수출 마진 분기 최대 전망\n"
        "            2. (0.45) 美 4월 SAAR 1580만대 — 컨센서스 부합, 전월비 보합\n"
        "            3. (0.38) Tesla Q1 인도량 -13% YoY → 글로벌 EV 수요 둔화 우려\n"
        "[관련 가설] 1. 원/달러 환율 강세 → 현대차·기아 수출 마진 개선\n"
        "            2. 미국 월간 자동차 판매(SAAR) → 한국 OEM·부품주\n"
        "            3. EV 전환 속도 — Tesla·중국 EV 대비 현대차그룹 포지션"
    )
    output = {
        "positive_factors": [
            "USD/KRW 1450원 돌파(감성 0.72)로 수출 마진 분기 최대 전망 — 환율 1% 절하당 영업이익 약 800억 증가 구조",
            "관련 미국 점수 0.62 — F·GM 등 글로벌 OEM 가이던스 우호적, 美 SAAR 1580만대로 견조한 수요 유지",
            "수급 점수 0.61로 외국인·기관 매수 우위 — 환율 모멘텀에 따른 단기 자금 유입",
        ],
        "risk_factors": [
            "Tesla 인도량 -13% YoY 등 글로벌 EV 수요 둔화 신호로 EV 라인업(아이오닉, EV9) 모멘텀은 제한적",
            "섹터 점수 0.48로 자동차 업종 전반은 중립 구간 — 환율 효과 외 추가 모멘텀이 부재해 단기 상방은 제한적",
        ],
        "comment": (
            "환율 우호와 글로벌 EV 둔화 우려가 혼재된 관망 구간입니다. "
            "환율 모멘텀이 단기 가격 지지 요인으로 작용할 수 있으나, 추가 신호 (4월 글로벌 판매대수, EV 가이던스) 확인 후 방향성 평가가 권장됩니다."
        ),
    }
    return user, output


def _few_shot_caution() -> tuple[str, dict]:
    user = (
        "[종목] 한미반도체 (042700) · 섹터: 반도체\n"
        "[오늘 신호] 주의 · 점수 0.42\n"
        "[sub-score] 글로벌 0.58, 섹터 0.55, 관련 미국 0.62, 뉴스 0.48, 펀더멘털 0.50, 수급 0.28, 리스크 0.85\n"
        "[관련 뉴스] 1. (0.55) 한미반도체, 5거래일 연속 +20% 급등 후 차익실현 매물 출회\n"
        "            2. (0.42) 외국인 3거래일 연속 순매도 (누적 -780억)\n"
        "            3. (0.58) HBM 후공정 장비 신규 수주 — 다만 추가 모멘텀 부재\n"
        "[관련 가설] 1. Nvidia 데이터센터 매출 호조 → HBM 공급망 수혜\n"
        "            2. ASML 수주·실적 → 한국 반도체 장비·소재 수요"
    )
    output = {
        "positive_factors": [
            "관련 미국 종목 점수 0.62로 NVDA·TSM 등 글로벌 반도체 사이클은 여전히 우호적",
            "HBM 후공정 신규 수주 보도(감성 0.58)로 중장기 펀더멘털은 견조",
            "섹터 점수 0.55로 반도체 업종 전반 약세 국면은 아님",
        ],
        "risk_factors": [
            "리스크 점수 0.85로 5거래일 연속 +20% 급등 후 단기 과열 — 추격 진입 시 변동성 확대 위험",
            "외국인 3거래일 연속 순매도 -780억 누적으로 수급 점수 0.28까지 위축, 단기 차익실현 압력 지속 가능성",
        ],
        "comment": (
            "중장기 펀더멘털은 양호하나 단기 과열 + 외국인 매도 압력이 겹쳐 변동성 주의 구간입니다. "
            "가격 안정 후 수급 회복 신호 확인 후 접근이 권장됩니다."
        ),
    }
    return user, output


def _few_shot_risk() -> tuple[str, dict]:
    user = (
        "[종목] LG에너지솔루션 (373220) · 섹터: 2차전지\n"
        "[오늘 신호] 위험 · 점수 0.28\n"
        "[sub-score] 글로벌 0.42, 섹터 0.25, 관련 미국 0.18, 뉴스 0.22, 펀더멘털 0.50, 수급 0.32, 리스크 0.65\n"
        "[관련 뉴스] 1. (0.15) Tesla Q4 인도량 컨센서스 -8% 미스, 가이던스 하향\n"
        "            2. (0.20) 美 IRA EV 세액공제 폐지 발의안 의회 상정\n"
        "            3. (0.32) CATL 유럽 신규 공장 발표 — 한국 셀 점유율 잠식 우려\n"
        "[관련 가설] 1. Tesla 분기 인도량 → 한국 배터리 셀 공급사 수혜\n"
        "            2. 美 IRA EV 보조금·정책 변동 → 한국 셀 수출 영향\n"
        "            3. 중국 셀(CATL, BYD) 경쟁 강화 → 한국 셀 마진 압박"
    )
    output = {
        "positive_factors": [
            "글로벌 시장 점수 0.42로 거시 환경 자체가 극단적 약세는 아니며 섹터 회복 시 우선 반등 후보",
            "펀더멘털 점수 0.50으로 사업 구조·재무 건전성은 안정적, 단기 노이즈와 구분 필요",
            "수급 점수 0.32로 외국인 매도 강도가 아직 패닉 수준은 아님 — 일부 가치 매수 유입 여지",
        ],
        "risk_factors": [
            "Tesla 인도량 미스(-8%) + 가이던스 하향이 직접 매출 우려로 작용. 관련 미국 점수 0.18로 가장 부정적",
            "IRA 폐지 발의 + CATL 유럽 진출 동시 발생 → 정책 리스크와 경쟁 리스크가 중첩되어 단기 하방 압력 지속 가능",
        ],
        "comment": (
            "다수 부정 요인이 동시에 정렬된 위험 구간입니다. "
            "정책 불확실성과 글로벌 EV 수요 둔화가 동시에 진행 중이므로 보수적 대응이 권장되며, "
            "IRA 가이드라인·Tesla 가이던스 후속 코멘트 확인 후 재평가가 필요합니다."
        ),
    }
    return user, output


FEW_SHOTS = [
    _few_shot_strong_interest(),
    _few_shot_neutral(),
    _few_shot_caution(),
    _few_shot_risk(),
]


def _build_few_shot_messages() -> list[dict[str, Any]]:
    msgs: list[dict[str, Any]] = []
    for i, (user_text, output) in enumerate(FEW_SHOTS):
        msgs.append({"role": "user", "content": user_text})
        msgs.append({
            "role": "assistant",
            "content": [{
                "type": "tool_use",
                "id": f"toolu_few_shot_report_{i}",
                "name": "record_report",
                "input": output,
            }],
        })
        msgs.append({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": f"toolu_few_shot_report_{i}",
                "content": "OK",
            }],
        })
    return msgs


# ──────────────────────────────────────────────────────────
# User-message rendering for the actual stock under analysis
# ──────────────────────────────────────────────────────────
def _render_user_message(
    *,
    name: str,
    ticker: str,
    sector: str,
    signal: str,
    final_score: float,
    sub_scores: dict,
    news_top3: list[dict],
    rag_top3: list[RetrievedChunk],
) -> str:
    lines = [
        f"[종목] {name} ({ticker}) · 섹터: {sector}",
        f"[오늘 신호] {signal} · 점수 {final_score:.2f}",
        "[sub-score] " + ", ".join([
            f"글로벌 {sub_scores.get('global_market', 0):.2f}",
            f"섹터 {sub_scores.get('sector', 0):.2f}",
            f"관련 미국 {sub_scores.get('related_us_stock', 0):.2f}",
            f"뉴스 {sub_scores.get('news_sentiment', 0):.2f}",
            f"펀더멘털 {sub_scores.get('fundamental', 0):.2f}",
            f"수급 {sub_scores.get('volume_flow', 0):.2f}",
            f"리스크 {sub_scores.get('risk_penalty', 0):.2f}",
        ]),
    ]

    if news_top3:
        lines.append("[관련 뉴스]")
        for i, item in enumerate(news_top3, start=1):
            score = item.get("sentiment_score") or 0.0
            title = item.get("title", "(제목 없음)")
            body = (item.get("body") or "")[:NEWS_BODY_TRUNCATE_CHARS]
            lines.append(f"  {i}. ({score:.2f}) {title}")
            if body:
                lines.append(f"     ↳ {body}")
    else:
        lines.append("[관련 뉴스] (오늘 매칭된 뉴스 없음 — 시장 데이터·가설만 활용)")

    if rag_top3:
        lines.append("[관련 가설]")
        for i, chunk in enumerate(rag_top3, start=1):
            body_preview = chunk.body[:RAG_BODY_TRUNCATE_CHARS]
            lines.append(f"  {i}. {chunk.topic}")
            lines.append(f"     ↳ {body_preview}")

    lines.append("")
    lines.append("위 자료를 바탕으로 record_report 도구를 호출해 positive_factors 3개, "
                 "risk_factors 2개, comment 1개를 생성하세요.")
    return "\n".join(lines)


def _cache_key(ticker: str, on_date: Date, model: str) -> str:
    h = hashlib.sha256(f"{on_date.isoformat()}|{ticker}|{model}".encode()).hexdigest()[:24]
    return f"report:{model}:{h}"


# ──────────────────────────────────────────────────────────
# Main class
# ──────────────────────────────────────────────────────────
class ReportGenerator:
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
        self._sem = asyncio.Semaphore(REPORT_CONCURRENCY)
        self._tool = pydantic_to_tool(
            StockReport,
            name="record_report",
            description="Record an objective per-stock investment report from a "
                        "Korean retail-investor perspective. Must follow CLAUDE.md "
                        "section 3-A (no forbidden words, no recommendations).",
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
    # Public — single stock
    # ──────────────────────────────────────────────────────
    async def generate_one(
        self,
        *,
        on_date: Date,
        ticker: str,
        name: str,
        sector: str,
        signal: str,
        final_score: float,
        sub_scores: dict,
        news_top3: list[dict],
        rag_top3: list[RetrievedChunk],
    ) -> StockReport:
        cache_key = _cache_key(ticker, on_date, self._model)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return with_disclaimer(StockReport.model_validate(cached))

        if not self._cost.can_call(on_date):
            raise DailyCapExceeded(
                f"Refusing additional LLM call for {on_date.isoformat()}"
            )

        user_msg = _render_user_message(
            name=name, ticker=ticker, sector=sector, signal=signal,
            final_score=final_score, sub_scores=sub_scores,
            news_top3=news_top3, rag_top3=rag_top3,
        )
        report = await self._call_with_validation(user_msg)
        self._cost.increment(on_date)

        finalized = with_disclaimer(report)
        # Cache the pre-disclaimer body so we can re-add disclaimer cleanly later.
        self._cache.set(cache_key, report.model_dump(), ttl_seconds=CACHE_TTL_SECONDS)
        return finalized

    # ──────────────────────────────────────────────────────
    # LLM call + validation retry loop
    # ──────────────────────────────────────────────────────
    async def _call_with_validation(self, user_msg: str) -> StockReport:
        """Up to 3 attempts (1 initial + 2 retries). On forbidden-word violation
        or schema parse failure, ask the model to regenerate."""
        last_error: Exception | None = None
        for attempt in range(MAX_VALIDATION_RETRIES + 1):
            try:
                report = await self._call_llm(user_msg, attempt=attempt)
                validate_report(report)
                return report
            except (ForbiddenWordError, ValidationError, ValueError) as exc:
                log.warning("Report attempt %d failed: %s: %s",
                            attempt + 1, type(exc).__name__, exc)
                last_error = exc
                continue
        raise ReportSkipped(
            f"Report generation failed after {MAX_VALIDATION_RETRIES + 1} attempts: {last_error}"
        )

    @retry(
        stop=stop_after_attempt(2),
        wait=wait_exponential(multiplier=1, min=1, max=4),
        retry=retry_if_exception_type(RuntimeError),
        reraise=True,
    )
    async def _call_llm(self, user_msg: str, *, attempt: int) -> StockReport:
        async with self._sem:
            client = self._ensure_client()
            messages = list(_build_few_shot_messages())
            if attempt > 0:
                # Tell the model previous output was rejected so it adjusts tone.
                messages.append({
                    "role": "user",
                    "content": (
                        "이전 응답에 금지어가 포함되었거나 형식이 어긋났습니다. "
                        "금지어를 절대 사용하지 말고 record_report 도구를 다시 호출하세요.\n\n"
                        + user_msg
                    ),
                })
            else:
                messages.append({"role": "user", "content": user_msg})

            response = await client.messages.create(
                model=self._model,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=SYSTEM_PROMPT,
                tools=[self._tool],
                tool_choice={"type": "tool", "name": "record_report"},
                messages=messages,
            )
        payload = extract_tool_input(response, "record_report")
        return StockReport.model_validate(payload)


# ──────────────────────────────────────────────────────────
# Batch + persistence
# ──────────────────────────────────────────────────────────
async def generate_batch(on_date: Date, generator: ReportGenerator | None = None) -> dict[str, int]:
    """Generate reports for every ticker that has an ai_score row on `on_date`.

    Updates ai_scores.rationale_json in place. Returns counts.
    """
    sb = get_admin_client()
    rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, "
                  "global_market_score, sector_score, related_us_stock_score, "
                  "news_sentiment_score, fundamental_score, volume_flow_score, "
                  "risk_penalty, "
                  "stocks(name, sector)")
          .eq("date", on_date.isoformat())
          .execute()
          .data
    ) or []

    log.info("generate_batch: %d ai_scores rows for %s", len(rows), on_date)
    generator = generator or ReportGenerator()

    succeeded, failed, skipped_cap = 0, 0, 0
    for row in rows:
        ticker = row["ticker"]
        try:
            stock = (row.get("stocks") or {})
            news_top3 = _fetch_top_news(sb, ticker, on_date)
            rag_top3 = await _fetch_top_rag(ticker, stock.get("sector", ""), generator._embedder)
            report = await generator.generate_one(
                on_date=on_date,
                ticker=ticker,
                name=stock.get("name", ticker),
                sector=stock.get("sector", "기타"),
                signal=row["signal"],
                final_score=row["final_score"],
                sub_scores={
                    "global_market":     row.get("global_market_score") or 0.5,
                    "sector":            row.get("sector_score") or 0.5,
                    "related_us_stock":  row.get("related_us_stock_score") or 0.5,
                    "news_sentiment":    row.get("news_sentiment_score") or 0.5,
                    "fundamental":       row.get("fundamental_score") or 0.5,
                    "volume_flow":       row.get("volume_flow_score") or 0.5,
                    "risk_penalty":      row.get("risk_penalty") or 0.5,
                },
                news_top3=news_top3,
                rag_top3=rag_top3,
            )
            sb.table("ai_scores").update({
                "rationale_json": report.model_dump(),
            }).eq("date", on_date.isoformat()).eq("ticker", ticker).execute()
            succeeded += 1
        except DailyCapExceeded:
            log.warning("Daily LLM cap hit; skipping remaining %d", len(rows) - succeeded)
            skipped_cap = len(rows) - succeeded - failed
            break
        except ReportSkipped as exc:
            log.warning("ticker=%s skipped (validation exhausted): %s", ticker, exc)
            failed += 1
        except Exception as exc:
            log.warning("ticker=%s failed: %s", ticker, exc)
            failed += 1

    log.info("generate_batch done — succeeded=%d failed=%d skipped_by_cap=%d",
             succeeded, failed, skipped_cap)
    return {"succeeded": succeeded, "failed": failed, "skipped_by_cap": skipped_cap}


def _fetch_top_news(sb, ticker: str, on_date: Date) -> list[dict]:
    rows = (
        sb.table("news_items")
          .select("title, body, sentiment_score, related_symbols")
          .eq("date", on_date.isoformat())
          .contains("related_symbols", [ticker])
          .order("sentiment_score", desc=True)
          .limit(3)
          .execute()
          .data
    ) or []
    return rows


async def _fetch_top_rag(ticker: str, sector: str, embedder: Embedder) -> list[RetrievedChunk]:
    query = f"{sector} 섹터 {ticker} 관련 시장 동향 및 투자 가설"
    return await retrieve(query, ticker=ticker, top_k=3, embedder=embedder)
