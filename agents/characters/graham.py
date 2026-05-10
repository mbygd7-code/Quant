"""Graham — value analyst.

Computes intrinsic value via two methods (PER, PBR), takes the more
conservative of the two as the working figure, derives a safety
margin against the latest close, and combines that with a quality
score (0..100) to produce a -2..+2 score.

DCF is omitted in M2 because ``kr_financials`` doesn't carry FCF
yet. We'll add it once the collector lands and make the conservative
intrinsic value the min of three (M3+).

The arithmetic lives in pure-functional helpers so the calculator
runs without LLM access (cheap unit tests). The LLM call is reserved
for the narrative — the score is fully deterministic.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import ClassVar

from pydantic import BaseModel, Field

from agents.characters._base import Character, InsufficientDataError
from agents.characters._data import (
    KrFinancialsRow,
    KrFundamentalsRow,
    KrQuoteRow,
    daily_quotes,
    latest_fundamentals,
    recent_financials,
)
from agents.db.models import AgentName, AgentOutputNew
from agents.llm import (
    CacheBlock,
    ClaudeMessage,
    call_claude,
    sanitize_narrative_safe,
)

# ─── Tunable constants (kept here, not in agents/weights/, because
#     these are Graham's bookkeeping not the user-tunable weight set) ─

#: Earnings-growth clamp (revenue YoY is noisy at extremes).
GROWTH_CLAMP_LOW = Decimal("-0.20")
GROWTH_CLAMP_HIGH = Decimal("0.30")

#: PER cap from Graham's original formula (8.5 + 2*growth pct), where
#: growth pct is in percent units (so 0.10 → 10).
PER_CAP = Decimal("15.0")
PER_BASE = Decimal("8.5")
PER_GROWTH_COEF = Decimal("2.0")
#: PER floor — even shrinking-earnings companies don't have a negative
#: fair PE. 3.0 = "deep distressed but still going-concern" — produces
#: an intrinsic value that's lower than the no-growth baseline (8.5)
#: while staying positive so the safety-margin math doesn't flip sign.
PER_FLOOR = Decimal("3.0")

#: PBR multiplier capped (highly profitable firms above 2x book are
#: rare; Graham would distrust higher multiples).
PBR_CAP = Decimal("2.0")

#: Quality score breakdown (max 100):
QUALITY_ROE_HIGH_BONUS = 25     # ROE > 15% (5q avg)
QUALITY_ROE_MID_BONUS = 15      # ROE 10-15%
QUALITY_ROE_LOW_BONUS = 5       # ROE 5-10%
QUALITY_ROE_STABILITY_BONUS = 15  # std dev < 0.05 → bonus on top
QUALITY_OPYOY_PER_QUARTER = 5   # +5 per quarter with positive op-income YoY
QUALITY_REVTREND_IMPROVING = 20
QUALITY_REVTREND_STABLE = 15
QUALITY_REVTREND_DECLINING = 0


@dataclass(frozen=True)
class GrahamInputs:
    """Pre-fetched data bundle. The cycle orchestrator does the
    fetching; ``Graham.analyze`` accepts pre-fetched inputs in tests."""

    fundamentals: KrFundamentalsRow
    financials: list[KrFinancialsRow]  # newest first, ≥ 5 quarters expected
    quotes: list[KrQuoteRow]            # newest first, ≥ 1 quote expected


@dataclass(frozen=True)
class IntrinsicValueBreakdown:
    per_method: Decimal | None
    pbr_method: Decimal | None
    conservative: Decimal | None
    method_used: str  # "min(PER,PBR)" / "PER only" / "PBR only" / "none"


class GrahamPayload(BaseModel):
    """Schema for ``raw_payload`` written to ``agent_outputs``."""

    quality_score: int = Field(ge=0, le=100)
    intrinsic_value_per: float | None
    intrinsic_value_pbr: float | None
    intrinsic_value_conservative: float | None
    method_used: str
    current_price: float
    safety_margin_pct: float | None
    revenue_growth_5q: float | None
    roe_5q_avg: float | None
    data_window_quarters: int


class GrahamLLMResponse(BaseModel):
    """The model is asked to return only this structure."""

    narrative: str = Field(min_length=10)


# ─── Pure-function calculators ──────────────────────────────────────


def _avg(values: list[float]) -> float | None:
    cleaned = [v for v in values if v is not None]
    if not cleaned:
        return None
    return sum(cleaned) / len(cleaned)


def _stdev(values: list[float]) -> float | None:
    cleaned = [v for v in values if v is not None]
    if len(cleaned) < 2:
        return None
    mean = sum(cleaned) / len(cleaned)
    var = sum((v - mean) ** 2 for v in cleaned) / (len(cleaned) - 1)
    return var ** 0.5


def quality_score(financials: list[KrFinancialsRow]) -> int:
    """0..100. Walks five most-recent quarters."""
    if not financials:
        return 0
    window = financials[:5]
    score = 0

    # 1) ROE bucket — but kr_financials has no ROE column directly;
    #    we approximate ROE bucket separately from kr_fundamentals.
    #    Here we credit operating-income trend as the available proxy:
    op_yoy = [f.op_income_yoy for f in window if f.op_income_yoy is not None]
    if op_yoy:
        positive = sum(1 for v in op_yoy if v > 0)
        score += min(positive * QUALITY_OPYOY_PER_QUARTER, 25)

    # 2) Revenue trend
    rev_yoy = [f.revenue_yoy for f in window if f.revenue_yoy is not None]
    if rev_yoy:
        avg_rev = sum(rev_yoy) / len(rev_yoy)
        recent_rev = rev_yoy[0]
        if recent_rev > avg_rev:
            score += QUALITY_REVTREND_IMPROVING
        elif abs(recent_rev - avg_rev) <= 0.02:
            score += QUALITY_REVTREND_STABLE
        else:
            score += QUALITY_REVTREND_DECLINING

    # 3) Net income consistency — count quarters with positive net.
    net_pos = sum(1 for f in window if (f.net_income or 0) > 0)
    score += net_pos * 5  # max 25

    return min(score, 100)


def quality_score_with_roe(
    financials: list[KrFinancialsRow], roe_now: float | None
) -> int:
    """Variant adding the snapshot ROE from kr_fundamentals."""
    base = quality_score(financials)
    if roe_now is None:
        return base
    if roe_now > 0.15:
        bonus = QUALITY_ROE_HIGH_BONUS
    elif roe_now > 0.10:
        bonus = QUALITY_ROE_MID_BONUS
    elif roe_now > 0.05:
        bonus = QUALITY_ROE_LOW_BONUS
    else:
        bonus = 0
    return min(base + bonus, 100)


def _decimal(v: float | int | None) -> Decimal | None:
    if v is None:
        return None
    return Decimal(str(v))


def per_intrinsic_value(
    *, eps: Decimal, growth_rate: Decimal
) -> Decimal:
    """Graham's classic PER-fair-value formula, simplified.

    fair_per = clamp(growth_pct, GROWTH_CLAMP) and
    fair_per = min(PER_CAP, PER_BASE + PER_GROWTH_COEF * growth_pct)
    growth_pct here is in percent units (0.10 → 10).
    """
    growth_clamped = max(GROWTH_CLAMP_LOW, min(GROWTH_CLAMP_HIGH, growth_rate))
    growth_pct = growth_clamped * Decimal("100")  # fraction → percent units
    # Graham: fair_per = 8.5 + 2 × growth%
    # Hard cap at PER_CAP since the formula explodes at growth > 3.25%.
    fair_per = max(
        PER_FLOOR, min(PER_CAP, PER_BASE + PER_GROWTH_COEF * growth_pct)
    )
    return (eps * fair_per).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def pbr_intrinsic_value(*, bps: Decimal, roe: Decimal) -> Decimal:
    """Conservative PBR-fair-value: BPS × min(PBR_CAP, ROE × 10)."""
    multiplier = min(PBR_CAP, roe * Decimal("10"))
    if multiplier <= 0:
        return Decimal("0")
    return (bps * multiplier).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def intrinsic_value(
    *,
    fundamentals: KrFundamentalsRow,
    financials: list[KrFinancialsRow],
    current_price: Decimal,
) -> IntrinsicValueBreakdown:
    """Compute the conservative (= min) intrinsic value from PER + PBR."""
    per_v: Decimal | None = None
    pbr_v: Decimal | None = None

    # PER method needs trailing_pe (price/EPS) and a recent EPS proxy.
    # kr_fundamentals stores PE not EPS, so derive EPS from PE + price.
    if fundamentals.trailing_pe and fundamentals.trailing_pe > 0:
        eps = current_price / Decimal(str(fundamentals.trailing_pe))
        rev_yoys = [f.revenue_yoy for f in financials[:5] if f.revenue_yoy is not None]
        avg_growth = _avg([float(g) for g in rev_yoys]) if rev_yoys else 0.0
        per_v = per_intrinsic_value(
            eps=eps, growth_rate=Decimal(str(avg_growth or 0.0))
        )

    # PBR method needs price_to_book and ROE.
    if (
        fundamentals.price_to_book
        and fundamentals.price_to_book > 0
        and fundamentals.roe
        and fundamentals.roe > 0
    ):
        bps = current_price / Decimal(str(fundamentals.price_to_book))
        pbr_v = pbr_intrinsic_value(
            bps=bps, roe=Decimal(str(fundamentals.roe))
        )

    if per_v is not None and pbr_v is not None:
        conservative = min(per_v, pbr_v)
        method = "min(PER,PBR)"
    elif per_v is not None:
        conservative = per_v
        method = "PER only"
    elif pbr_v is not None:
        conservative = pbr_v
        method = "PBR only"
    else:
        return IntrinsicValueBreakdown(None, None, None, "none")

    return IntrinsicValueBreakdown(
        per_method=per_v,
        pbr_method=pbr_v,
        conservative=conservative,
        method_used=method,
    )


def safety_margin_pct(
    intrinsic_value: Decimal, current_price: Decimal
) -> Decimal:
    """(intrinsic - current) / intrinsic, in fractional terms (0.25 = 25%)."""
    if intrinsic_value <= 0:
        return Decimal("0")
    return (
        (intrinsic_value - current_price) / intrinsic_value
    ).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def safety_margin_to_score(margin: Decimal) -> Decimal:
    """Map safety margin to a base score in [-1.5, +1.5].

    > +25%   →  +1.5
    +10..+25 →  +0.7
    -10..+10 →   0
    -25..-10 →  -0.7
    < -25%   →  -1.5
    """
    if margin >= Decimal("0.25"):
        return Decimal("1.5")
    if margin >= Decimal("0.10"):
        return Decimal("0.7")
    if margin >= Decimal("-0.10"):
        return Decimal("0")
    if margin >= Decimal("-0.25"):
        return Decimal("-0.7")
    return Decimal("-1.5")


def combine_score(safety_score: Decimal, quality: int) -> Decimal:
    """Quality boost amplifies (or dampens) the safety-margin score.

    score = clamp(safety_score * (1 + quality/200), -2.00, 2.00)

    quality=0   → no amplification (baseline)
    quality=100 → 1.5x amplification, but clamped at the bounds
    """
    boost = Decimal(1) + Decimal(quality) / Decimal(200)
    raw = safety_score * boost
    return max(Decimal("-2.00"), min(Decimal("2.00"), raw)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


# ─── The character ───────────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "당신은 'Graham'입니다. 벤저민 그레이엄의 가치투자 철학으로 한국주식을 평가합니다. "
    "안전마진(intrinsic value 대비 할인율)과 비즈니스 품질이 핵심입니다. "
    "결정적 단어('매수', '매도', '강력 추천', '확정', '보장', '오늘 오른다', '오늘 내린다', '100%')를 "
    "절대 사용하지 마세요. '안전마진이 X%로 충분히 매력적입니다', "
    "'본질가치 대비 X% 할인된 수준입니다' 같은 비교형 표현만 사용하세요. "
    "응답은 반드시 다음 JSON 스키마로만: {\"narrative\": \"<150자 이내 한국어 평가>\"}"
)


class Graham(Character):
    agent_name: ClassVar[AgentName] = "graham"

    def fetch(self, ticker: str) -> GrahamInputs:
        """Pre-fetch the data window. Separate from analyze() so tests
        can inject fixtures without monkey-patching DB calls."""
        fundamentals = latest_fundamentals(ticker)
        if fundamentals is None:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason="no kr_fundamentals row",
            )
        financials = recent_financials(ticker, n=8)
        if len(financials) < 2:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=f"need ≥2 quarters of kr_financials, got {len(financials)}",
            )
        quotes = daily_quotes(ticker, days=10)  # only need latest close
        if not quotes or quotes[0].close is None:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason="no recent close",
            )
        return GrahamInputs(
            fundamentals=fundamentals, financials=financials, quotes=quotes
        )

    def analyze(
        self,
        ticker: str,
        cycle_at: datetime,
        inputs: GrahamInputs | None = None,
    ) -> AgentOutputNew:
        """Compute the score + raw payload, then ask Claude for a
        narrative. Returns a row ready to insert."""
        bundle = inputs or self.fetch(ticker)

        current_price = Decimal(str(bundle.quotes[0].close))
        iv = intrinsic_value(
            fundamentals=bundle.fundamentals,
            financials=bundle.financials,
            current_price=current_price,
        )
        if iv.conservative is None:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason="neither PER nor PBR method produced a value",
            )

        margin = safety_margin_pct(iv.conservative, current_price)
        safety_base = safety_margin_to_score(margin)

        quality = quality_score_with_roe(
            bundle.financials, bundle.fundamentals.roe
        )
        score = combine_score(safety_base, quality)

        rev_yoys = [
            f.revenue_yoy for f in bundle.financials[:5] if f.revenue_yoy is not None
        ]
        avg_rev = _avg([float(g) for g in rev_yoys]) if rev_yoys else None

        payload = GrahamPayload(
            quality_score=quality,
            intrinsic_value_per=float(iv.per_method) if iv.per_method else None,
            intrinsic_value_pbr=float(iv.pbr_method) if iv.pbr_method else None,
            intrinsic_value_conservative=float(iv.conservative),
            method_used=iv.method_used,
            current_price=float(current_price),
            safety_margin_pct=float(margin) * 100,
            revenue_growth_5q=avg_rev,
            roe_5q_avg=bundle.fundamentals.roe,
            data_window_quarters=len(bundle.financials),
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
        payload: GrahamPayload,
        score: Decimal,
    ) -> tuple[str, str, float]:
        cache = [
            CacheBlock(
                text=_facts_block(ticker, payload, score),
                label="graham-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_SYSTEM_PROMPT,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 데이터로 {ticker} 종목에 대한 Graham 관점의 평가를 "
                        "한국어 150자 이내로 작성하세요. 본질가치 대비 현재가 위치와 "
                        "사업의 품질을 모두 언급하되, 매매 권유 표현은 사용하지 마세요."
                    ),
                ),
            ],
            response_model=GrahamLLMResponse,
        )
        if parsed is None:
            # Should not happen — call_claude raises on parse failure
            raise RuntimeError("call_claude returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        return narrative, result.model, result.cost_estimate_usd


def _facts_block(ticker: str, payload: GrahamPayload, score: Decimal) -> str:
    lines = [
        f"종목: {ticker}",
        f"현재가: {payload.current_price:,.0f}원",
        f"본질가치(보수): {payload.intrinsic_value_conservative:,.0f}원 ({payload.method_used})",
        f"안전마진: {payload.safety_margin_pct:+.1f}%",
        f"품질점수: {payload.quality_score}/100",
        f"최근 ROE: {(payload.roe_5q_avg or 0) * 100:.1f}%",
        f"매출 성장 5Q 평균: {(payload.revenue_growth_5q or 0) * 100:+.1f}%",
        f"PER 본질가치: {payload.intrinsic_value_per or '—'}",
        f"PBR 본질가치: {payload.intrinsic_value_pbr or '—'}",
        f"산출 점수: {score}",
        f"분석 분기 수: {payload.data_window_quarters}",
    ]
    return "\n".join(lines)


