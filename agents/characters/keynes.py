"""Keynes — macro analyst.

Maps recent macro deltas through ``kr_macro_betas`` to a per-ticker
expected-return proxy. The five factors are USDKRW, ^TNX, ^VIX, DXY,
WTI — already populated by the legacy macro-beta backfill (migration
16).

Algorithm (deterministic; LLM only writes the narrative):

  for each factor f in [USDKRW, ^TNX, ^VIX, DXY, WTI]:
      delta_5d[f] = (close[today] - close[5d ago]) / close[5d ago] × 100   (percent units)
      beta[f]     = kr_macro_betas row for (ticker, f) — or 0 if missing
      contribution[f] = beta[f] × delta_5d[f]                              (percent points)

  expected_return = sum(contribution[f])
  score           = clamp(expected_return × 0.5, -2.00, +2.00)

  +4% expected → +2.0 (cap)
  +1% expected → +0.50
  -1% expected → -0.50
  -4% expected → -2.0 (cap)

Tickers without any macro_betas rows raise InsufficientDataError —
the cycle orchestrator skips and re-evaluates next time.

This is forward-leaning by construction: a recently-strong won (USDKRW
falling) for an exporter with negative beta to USDKRW shows up as a
positive contribution today. Keynes interprets it as "the macro tail
is helping" rather than predicting next week's move.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import ClassVar

from pydantic import BaseModel, Field

from agents.characters._base import Character, InsufficientDataError
from agents.characters._data import (
    GlobalMarketRow,
    MacroBetaRow,
    global_quotes,
    macro_betas,
)
from agents.db.models import AgentName, AgentOutputNew
from agents.llm import (
    CacheBlock,
    ClaudeMessage,
    call_claude,
    sanitize_narrative,
)

# ─── Tunables ───────────────────────────────────────────────────────

#: Five macro factors Keynes tracks. Match what's populated in
#: kr_macro_betas (migration 16 + the matching collector).
MACRO_FACTORS: tuple[str, ...] = ("USDKRW", "^TNX", "^VIX", "DXY", "WTI")

#: Lookback window for each factor's recent move.
LOOKBACK_DAYS = 5

#: Score scaling: expected_return × 0.5 → score. With caps at ±2.00,
#: a 4% expected return saturates Keynes' contribution. The 0.5
#: factor is intentionally conservative — Keynes is one of four (M3)
#: voters; oversaturating drowns out the others.
SCORE_SCALE = Decimal("0.5")


# ─── Data shapes ────────────────────────────────────────────────────


@dataclass(frozen=True)
class FactorContribution:
    factor: str
    delta_5d_pct: float        # macro factor's 5-day move in percent
    beta: float                # ticker's regression coefficient
    contribution_pct: float    # beta × delta — percent points


@dataclass(frozen=True)
class KeynesInputs:
    """Pre-fetched inputs so tests skip the DB."""

    macro_series: dict[str, list[GlobalMarketRow]]   # factor → newest-first quotes
    betas: dict[str, MacroBetaRow]                   # factor → row (subset)


class KeynesPayload(BaseModel):
    factors: list[dict[str, float | str]] = Field(default_factory=list)
    expected_return_pct: float
    factors_with_beta: int
    factors_total: int


class KeynesLLMResponse(BaseModel):
    narrative: str = Field(min_length=10)


# ─── Pure-function calculators ──────────────────────────────────────


def factor_delta_5d(series: list[GlobalMarketRow]) -> float | None:
    """5-day percent change of the macro factor's close. Returns ``None``
    when the window is too thin or anchor close is zero."""
    closes = [s.close for s in series if s.close is not None]
    if len(closes) <= LOOKBACK_DAYS:
        return None
    today = closes[0]
    anchor = closes[LOOKBACK_DAYS]
    if anchor == 0:
        return None
    return (today - anchor) / anchor * 100.0


def factor_contribution(
    factor: str,
    series: list[GlobalMarketRow],
    beta_row: MacroBetaRow | None,
) -> FactorContribution:
    """Compose one factor's row of the contribution matrix.

    Beta defaults to 0 when the ticker has no row for this factor —
    that's the common case for KR names that haven't been backfilled
    against every macro yet.
    """
    delta = factor_delta_5d(series) or 0.0
    beta = beta_row.beta if beta_row is not None else 0.0
    contribution = beta * delta
    return FactorContribution(
        factor=factor,
        delta_5d_pct=delta,
        beta=beta,
        contribution_pct=contribution,
    )


def expected_return_pct(contributions: list[FactorContribution]) -> float:
    return sum(c.contribution_pct for c in contributions)


def score_from_expected_return(expected_pct: float) -> Decimal:
    """Map expected_return (percent points) to a -2..+2 score."""
    raw = Decimal(str(expected_pct)) * SCORE_SCALE
    bounded = max(Decimal("-2.00"), min(Decimal("2.00"), raw))
    return bounded.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ─── Character ─────────────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "당신은 'Keynes'입니다. 매크로 분석가로서 환율·금리·유가 등 거시 변수가 "
    "*해당 섹터에 어떤 영향을 주는지* 진단합니다. 추상적 경제학 강의가 아니라 "
    "실용적 영향에 집중하세요. 결정적 단어('매수', '매도', '강력 추천', '확정', "
    "'보장', '오늘 오른다', '오늘 내린다', '100%')를 절대 사용하지 마세요. "
    "예: '원달러가 +1.2% 움직였고 이 종목 베타 -2.1로 -2.5% 역풍이 예상됩니다'. "
    "응답은 반드시 다음 JSON 스키마: "
    "{\"narrative\": \"<150자 이내 한국어 평가>\"}"
)


class Keynes(Character):
    agent_name: ClassVar[AgentName] = "keynes"

    def fetch(self, ticker: str) -> KeynesInputs:
        betas = macro_betas(ticker)
        if not betas:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason="no kr_macro_betas rows for this ticker",
            )
        series = {
            factor: global_quotes(factor, days=LOOKBACK_DAYS + 5)
            for factor in MACRO_FACTORS
        }
        return KeynesInputs(macro_series=series, betas=betas)

    def analyze(
        self,
        ticker: str,
        cycle_at: datetime,
        inputs: KeynesInputs | None = None,
    ) -> AgentOutputNew:
        bundle = inputs or self.fetch(ticker)

        contributions = [
            factor_contribution(
                factor=f,
                series=bundle.macro_series.get(f, []),
                beta_row=bundle.betas.get(f),
            )
            for f in MACRO_FACTORS
        ]

        expected = expected_return_pct(contributions)
        score = score_from_expected_return(expected)
        factors_with_beta = sum(
            1 for c in contributions if c.beta != 0.0
        )

        payload = KeynesPayload(
            factors=[
                {
                    "factor": c.factor,
                    "delta_5d_pct": round(c.delta_5d_pct, 4),
                    "beta": round(c.beta, 4),
                    "contribution_pct": round(c.contribution_pct, 4),
                }
                for c in contributions
            ],
            expected_return_pct=round(expected, 4),
            factors_with_beta=factors_with_beta,
            factors_total=len(MACRO_FACTORS),
        )

        narrative, model, cost = self._llm_narrative(
            ticker, payload, score, contributions
        )

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
        payload: KeynesPayload,
        score: Decimal,
        contributions: list[FactorContribution],
    ) -> tuple[str, str, float]:
        cache = [
            CacheBlock(
                text=_facts_block(ticker, payload, score, contributions),
                label="keynes-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_SYSTEM_PROMPT,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 데이터로 {ticker} 종목의 매크로 영향을 한국어 150자 "
                        "이내로 평가하세요. 가장 큰 영향을 주는 변수 1-2개를 "
                        "구체적 숫자(%)와 함께 언급하되, 매매 권유 표현은 "
                        "사용하지 마세요."
                    ),
                ),
            ],
            response_model=KeynesLLMResponse,
        )
        if parsed is None:
            raise RuntimeError("call_claude returned no parsed response")
        narrative = sanitize_narrative(parsed.narrative.strip())
        return narrative, result.model, result.cost_estimate_usd


def _facts_block(
    ticker: str,
    payload: KeynesPayload,
    score: Decimal,
    contributions: list[FactorContribution],
) -> str:
    lines = [
        f"종목: {ticker}",
        "매크로 5요소 5일 변동 × β:",
    ]
    for c in contributions:
        lines.append(
            f"  - {c.factor}: 변동 {c.delta_5d_pct:+.2f}%, "
            f"β {c.beta:+.2f} → 기여 {c.contribution_pct:+.2f}%p"
        )
    lines.extend([
        f"기대 변동 합계: {payload.expected_return_pct:+.2f}%",
        f"매핑된 베타 수: {payload.factors_with_beta}/{payload.factors_total}",
        f"산출 점수: {score}",
    ])
    return "\n".join(lines)
