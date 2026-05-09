"""Dow — technical analyst.

3-axis trend diagnosis (primary 200-day, secondary 60-day, minor
5/20-day) plus volume confirmation. Like Graham, the score is
deterministic; the LLM only writes the narrative.

Algorithm summary (see character-dow.md §3, simplified for M2):

  primary   = +1 if close > MA200 and MA60 > MA200
              -1 if close < MA200 and MA60 < MA200
               0 otherwise
  secondary = +1/-1/0 from MA20 vs MA60
  minor     = +1/-1/0 from MA5 vs MA20

  alignment = primary + secondary + minor      ∈ [-3, +3]

  base_score = alignment × 0.5                 ∈ [-1.5, +1.5]
  if not volume_confirmed: base_score *= 0.6
  score      = clamp(base_score, -2.00, +2.00)

We deliberately don't run the score outside [-1.5, +1.5] — Dow's
ceiling sits below the per-character extremes so Graham (gating on
fundamental discount) and Simons (M5, ML) can dominate the corners.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import ClassVar

from pydantic import BaseModel, Field

from agents.characters._base import Character, InsufficientDataError
from agents.characters._data import KrQuoteRow, daily_quotes
from agents.db.models import AgentName, AgentOutputNew
from agents.llm import (
    CacheBlock,
    ClaudeMessage,
    call_claude,
    sanitize_narrative,
)

#: Smallest history Dow can work with — 200 trading days for primary axis.
MIN_QUOTES_REQUIRED = 200

#: Volume confirmation thresholds.
VOL_CONFIRM_BULL = Decimal("1.10")   # recent vol must be ≥ 110% of 20d avg
VOL_CONFIRM_BEAR = Decimal("1.00")   # bear: any uptick is enough

#: Score dampening factor when volume doesn't confirm direction.
NO_VOLUME_DAMPEN = Decimal("0.6")

ALIGNMENT_LABELS: dict[int, str] = {
    3: "강한 상승세 (모든 축 일치)",
    2: "약한 상승세 (단기 또는 중기 약함)",
    1: "약한 상승세 (혼조)",
    0: "횡보",
    -1: "약한 하락세 (혼조)",
    -2: "약한 하락세 (단기 또는 중기 반등)",
    -3: "강한 하락세 (모든 축 일치)",
}


@dataclass(frozen=True)
class DowInputs:
    """Pre-fetched data bundle, newest-first.

    The 200-day primary axis dictates the minimum length; tests
    construct longer windows with synthetic data.
    """

    quotes: list[KrQuoteRow]


@dataclass(frozen=True)
class TrendAxes:
    primary: int
    secondary: int
    minor: int

    @property
    def alignment(self) -> int:
        return self.primary + self.secondary + self.minor


class DowPayload(BaseModel):
    primary_trend: int = Field(ge=-1, le=1)
    secondary_trend: int = Field(ge=-1, le=1)
    minor_trend: int = Field(ge=-1, le=1)
    alignment_label: str
    ma5: float
    ma20: float
    ma60: float
    ma200: float
    current_close: float
    volume_confirmed: bool
    recent_volume_ratio: float
    data_window_days: int


class DowLLMResponse(BaseModel):
    narrative: str = Field(min_length=10)


# ─── Pure-function calculators ──────────────────────────────────────


def _mean_close(quotes: list[KrQuoteRow], n: int) -> Decimal:
    """Mean of the first ``n`` (newest) close prices.

    Caller must guarantee ``len(quotes) >= n``; we don't repeat the
    InsufficientDataError check here so call sites stay readable.
    """
    closes = [q.close for q in quotes[:n] if q.close is not None]
    if not closes:
        raise ValueError("no close values in window")
    total = sum(closes)
    return (Decimal(total) / Decimal(len(closes))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def _mean_volume(quotes: list[KrQuoteRow], n: int) -> Decimal:
    vols = [q.volume for q in quotes[:n] if q.volume is not None]
    if not vols:
        return Decimal(0)
    total = sum(vols)
    return Decimal(total) / Decimal(len(vols))


def trend_axes(quotes: list[KrQuoteRow]) -> TrendAxes:
    """Compute primary/secondary/minor trend signs from MA stack.

    Requires 200 newest quotes. Caller should guard with
    ``InsufficientDataError`` upstream — this function will raise
    ``ValueError`` if the window is too thin (a programming error,
    not a data issue).
    """
    if len(quotes) < MIN_QUOTES_REQUIRED:
        raise ValueError(
            f"trend_axes needs ≥{MIN_QUOTES_REQUIRED} quotes, got {len(quotes)}"
        )

    close = quotes[0].close
    if close is None:
        raise ValueError("first quote has no close")
    close_d = Decimal(close)

    ma5 = _mean_close(quotes, 5)
    ma20 = _mean_close(quotes, 20)
    ma60 = _mean_close(quotes, 60)
    ma200 = _mean_close(quotes, 200)

    # Primary: close + MA60 both relative to MA200.
    if close_d > ma200 and ma60 > ma200:
        primary = 1
    elif close_d < ma200 and ma60 < ma200:
        primary = -1
    else:
        primary = 0

    # Secondary: MA20 vs MA60.
    if ma20 > ma60:
        secondary = 1
    elif ma20 < ma60:
        secondary = -1
    else:
        secondary = 0

    # Minor: MA5 vs MA20.
    if ma5 > ma20:
        minor = 1
    elif ma5 < ma20:
        minor = -1
    else:
        minor = 0

    return TrendAxes(primary=primary, secondary=secondary, minor=minor)


def volume_confirms(quotes: list[KrQuoteRow], alignment: int) -> tuple[bool, Decimal]:
    """Return (confirmed, recent_to_avg_ratio).

    Bull alignment requires recent volume ≥ 110% of 20d average.
    Bear alignment is more permissive: a 100%+ ratio suffices because
    sell-side panic naturally lifts volume.
    Sideways (alignment == 0) is always considered confirmed —
    there's no direction to confirm.
    """
    if len(quotes) < 20:
        return False, Decimal(0)
    avg20 = _mean_volume(quotes, 20)
    recent5 = _mean_volume(quotes, 5)
    if avg20 == 0:
        return False, Decimal(0)
    ratio = (recent5 / avg20).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if alignment == 0:
        return True, ratio
    threshold = VOL_CONFIRM_BULL if alignment > 0 else VOL_CONFIRM_BEAR
    return ratio >= threshold, ratio


def alignment_to_score(alignment: int, volume_confirmed: bool) -> Decimal:
    """Map (alignment, volume_confirmed) to score in [-2.00, +2.00].

    Base score = alignment × 0.5  →  [-1.5, +1.5].
    Without volume confirmation, dampened by 0.6.
    Final clamp into the schema bounds.
    """
    base = Decimal(alignment) * Decimal("0.5")
    if not volume_confirmed and alignment != 0:
        base *= NO_VOLUME_DAMPEN
    return max(Decimal("-2.00"), min(Decimal("2.00"), base)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


# ─── Character ─────────────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "당신은 'Dow'입니다. 찰스 다우의 기술적 분석으로 한국주식의 추세를 진단합니다. "
    "주추세(200일)·중기(60일)·단기(5/20일) 3축 일치도와 거래량 확증으로 강도를 평가합니다. "
    "결정적 단어('매수', '매도', '강력 추천', '확정', '보장', '오늘 오른다', '오늘 내린다', '100%')를 "
    "절대 사용하지 마세요. 시각적·동적 표현을 선호합니다 — '120일선이 지지 역할을 함', "
    "'거래량이 추세를 따라옴' 같은 차트 어투를 쓰세요. "
    "응답은 반드시 다음 JSON 스키마로만: {\"narrative\": \"<150자 이내 한국어 평가>\"}"
)


class Dow(Character):
    agent_name: ClassVar[AgentName] = "dow"

    def fetch(self, ticker: str) -> DowInputs:
        quotes = daily_quotes(ticker, days=MIN_QUOTES_REQUIRED + 50)
        # daily_quotes returns up to N rows; we may have fewer when
        # ingestion is shallow. The 200-day floor is a hard requirement.
        usable = [q for q in quotes if q.close is not None]
        if len(usable) < MIN_QUOTES_REQUIRED:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=(
                    f"{MIN_QUOTES_REQUIRED} trading-day closes required, "
                    f"got {len(usable)}"
                ),
            )
        return DowInputs(quotes=usable)

    def analyze(
        self,
        ticker: str,
        cycle_at: datetime,
        inputs: DowInputs | None = None,
    ) -> AgentOutputNew:
        bundle = inputs or self.fetch(ticker)
        if len(bundle.quotes) < MIN_QUOTES_REQUIRED:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=(
                    f"{MIN_QUOTES_REQUIRED} trading-day closes required, "
                    f"got {len(bundle.quotes)}"
                ),
            )

        axes = trend_axes(bundle.quotes)
        confirmed, ratio = volume_confirms(bundle.quotes, axes.alignment)
        score = alignment_to_score(axes.alignment, confirmed)

        ma5 = _mean_close(bundle.quotes, 5)
        ma20 = _mean_close(bundle.quotes, 20)
        ma60 = _mean_close(bundle.quotes, 60)
        ma200 = _mean_close(bundle.quotes, 200)
        close = bundle.quotes[0].close

        payload = DowPayload(
            primary_trend=axes.primary,
            secondary_trend=axes.secondary,
            minor_trend=axes.minor,
            alignment_label=ALIGNMENT_LABELS[axes.alignment],
            ma5=float(ma5),
            ma20=float(ma20),
            ma60=float(ma60),
            ma200=float(ma200),
            current_close=float(close) if close is not None else 0.0,
            volume_confirmed=confirmed,
            recent_volume_ratio=float(ratio),
            data_window_days=len(bundle.quotes),
        )

        narrative, model, cost = self._llm_narrative(ticker, payload, score)

        return AgentOutputNew(
            agent_name=self.agent_name,
            cycle_at=cycle_at,
            ticker=ticker,
            score=score,
            narrative=narrative,
            raw_payload=payload.model_dump(),
            model=model,
            cost_estimate=cost,
        )

    # ── LLM ────────────────────────────────────────────────────────

    def _llm_narrative(
        self,
        ticker: str,
        payload: DowPayload,
        score: Decimal,
    ) -> tuple[str, str, float]:
        cache = [
            CacheBlock(
                text=_facts_block(ticker, payload, score),
                label="dow-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_SYSTEM_PROMPT,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 데이터로 {ticker} 종목의 추세 진단을 한국어 150자 이내로 "
                        "작성하세요. 3축 일치도와 거래량 확증을 모두 언급하되, "
                        "매매 권유 표현은 사용하지 마세요."
                    ),
                ),
            ],
            response_model=DowLLMResponse,
        )
        if parsed is None:
            raise RuntimeError("call_claude returned no parsed response")
        narrative = sanitize_narrative(parsed.narrative.strip())
        return narrative, result.model, result.cost_estimate_usd


def _facts_block(ticker: str, payload: DowPayload, score: Decimal) -> str:
    return "\n".join([
        f"종목: {ticker}",
        f"현재가: {payload.current_close:,.0f}원",
        f"이동평균: MA5={payload.ma5:,.0f} MA20={payload.ma20:,.0f} MA60={payload.ma60:,.0f} MA200={payload.ma200:,.0f}",
        f"3축 추세: 주={payload.primary_trend:+d} 중기={payload.secondary_trend:+d} 단기={payload.minor_trend:+d}",
        f"합계 일치도: {payload.primary_trend + payload.secondary_trend + payload.minor_trend:+d}  ({payload.alignment_label})",
        f"거래량 확증: {'O' if payload.volume_confirmed else 'X'}  (recent5/avg20 = {payload.recent_volume_ratio:.2f})",
        f"산출 점수: {score}",
        f"분석 윈도우: {payload.data_window_days}일",
    ])
