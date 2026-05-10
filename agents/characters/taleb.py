"""Taleb — risk watcher.

The 6th and final voting character. Two outputs in one row:
  * ``score`` (the usual -2..+2) feeds Q1 weighted-sum like every
    other voter.
  * ``severity`` (1..5) feeds Q3 — Soros' auto-constraint that can
    force a grade down even when Q1 is bullish.

M4 simplifies the 4-check framework from character-taleb.md to what
already-loaded data can support:

  Check 1  Asymmetry        — 252-day vol + worst drawdown ratio
  Check 2  Data scepticism  — placeholder (M5+ wires per-character
                              accuracy lookups once history is deep)
  Check 3  Unknown unknowns — earnings-window proximity only
  Check 4  Tail scenarios   — LLM narrative only (no RAG yet)

Severity is computed deterministically from drawdown + volatility
buckets, with a one-step bump if earnings are imminent. The LLM call
is reserved for the narrative; Q3's auto-constraint runs on the
deterministic severity, so a flaky model can't accidentally hand-wave
the safety brake on or off.
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

#: Window for vol + drawdown.
LOOKBACK_DAYS = 252
MIN_QUOTES_REQUIRED = 60   # need at least 60 trading days for a useful σ

#: Asymmetry → score buckets (ratio = upside / downside).
ASYMMETRY_GOOD = Decimal("3.0")     # +1.0
ASYMMETRY_OKAY = Decimal("1.5")     # +0.5
ASYMMETRY_POOR_LO = Decimal("1.0")  # -0.5
ASYMMETRY_POOR_HI = Decimal("0.5")  # -1.0

#: Severity thresholds (drawdown, annualised vol). Tuples evaluated
#: top-down — first match wins.
SEVERITY_TABLE: tuple[tuple[Decimal, Decimal, int], ...] = (
    (Decimal("0.40"), Decimal("0.40"), 5),
    (Decimal("0.25"), Decimal("0.30"), 4),
    (Decimal("0.15"), Decimal("0.0"), 3),
    (Decimal("0.08"), Decimal("0.0"), 2),
)

#: Earnings window — within ±N calendar days of an estimated quarterly
#: report date raises severity by one step (cap at 5).
EARNINGS_PROXIMITY_DAYS = 7
QUARTER_DAYS = 91

#: Per-unknown penalty applied to risk_score (Check 3).
UNKNOWN_PENALTY = Decimal("0.3")


@dataclass(frozen=True)
class TalebInputs:
    """Pre-fetched bundle. ``quotes`` newest-first, ≥ MIN_QUOTES_REQUIRED."""

    quotes: list[KrQuoteRow]
    financials: list[KrFinancialsRow]


class TalebPayload(BaseModel):
    """Schema for ``raw_payload`` written to ``agent_outputs``."""

    # Check 1 — asymmetry
    annualised_vol: float
    max_drawdown: float
    upside_potential: float
    downside_risk: float
    asymmetry_ratio: float
    asymmetry_score: float

    # Check 2 — data scepticism (M4 placeholder)
    accuracy_lookup: float | None = None
    data_skepticism_score: float = 0.0

    # Check 3 — unknown unknowns
    earnings_imminent: bool
    days_to_estimated_earnings: int | None
    unknowns_count: int
    unknowns_score: float

    # Severity inputs
    severity: int = Field(ge=1, le=5)
    severity_bumped_by_earnings: bool

    # Composite
    risk_score: float
    data_window_days: int


class TalebLLMResponse(BaseModel):
    """The model returns only this structure. The narrative covers
    the four checks plus a brief tail-scenario sketch."""

    narrative: str = Field(min_length=10)


# ─── Pure-function calculators ──────────────────────────────────────


def _daily_returns(quotes: list[KrQuoteRow]) -> list[Decimal]:
    """Newest-first quotes → newest-first daily simple returns. The
    last element drops because there's no prior close to compare."""
    closes: list[Decimal] = []
    for q in quotes:
        if q.close is not None and q.close > 0:
            closes.append(Decimal(q.close))
    rets: list[Decimal] = []
    for newer, older in zip(closes, closes[1:]):
        if older == 0:
            continue
        rets.append((newer - older) / older)
    return rets


def annualised_volatility(quotes: list[KrQuoteRow]) -> Decimal:
    """σ_daily × √252 → annualised. Uses sample std-dev with N-1."""
    rets = _daily_returns(quotes[:LOOKBACK_DAYS])
    if len(rets) < 2:
        return Decimal("0")
    mean = sum(rets) / Decimal(len(rets))
    var = sum((r - mean) ** 2 for r in rets) / Decimal(len(rets) - 1)
    # √var × √252 — Decimal has no sqrt, so fall through float for the
    # one operation where precision doesn't matter (σ is a rough proxy).
    sigma = Decimal(str(float(var) ** 0.5))
    annual = (sigma * Decimal(str(252 ** 0.5))).quantize(
        Decimal("0.0001"), rounding=ROUND_HALF_UP
    )
    return annual


def max_drawdown_from_peak(quotes: list[KrQuoteRow]) -> Decimal:
    """Largest peak-to-trough drop in the lookback window, expressed
    as a positive fraction (0.32 = -32% drawdown)."""
    closes = [
        Decimal(q.close)
        for q in reversed(quotes[:LOOKBACK_DAYS])
        if q.close is not None and q.close > 0
    ]
    if len(closes) < 2:
        return Decimal("0")
    peak = closes[0]
    worst = Decimal("0")
    for c in closes[1:]:
        if c > peak:
            peak = c
        else:
            dd = (peak - c) / peak
            if dd > worst:
                worst = dd
    return worst.quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)


def asymmetry_components(
    annualised_vol: Decimal, max_dd: Decimal
) -> tuple[Decimal, Decimal, Decimal, Decimal]:
    """Returns ``(upside, downside, ratio, score)``.

    upside = annualised σ — one-σ upside as a proxy for "how much the
        stock can move in a year if conditions are favourable".
    downside = realised max drawdown (peak-to-trough) — what the stock
        *actually did* fall once. When the lookback has no drawdown
        (flat or always-rising series), fall back to vol so the ratio
        is well-defined and lands in the neutral bucket.

    A ratio > 1 means current volatility is high relative to the
    historical worst drop — Taleb reads this as "there's energy on the
    upside the past hasn't yet realised". A ratio < 1 means the stock
    has fallen further than its current vol suggests it should — bad
    asymmetry.
    """
    upside = annualised_vol
    downside = max_dd if max_dd > 0 else annualised_vol
    if downside <= 0:
        # No history → treat as neutral.
        return upside, downside, Decimal("0"), Decimal("0")

    ratio = (upside / downside).quantize(
        Decimal("0.0001"), rounding=ROUND_HALF_UP
    )
    if ratio >= ASYMMETRY_GOOD:
        score = Decimal("1.0")
    elif ratio >= ASYMMETRY_OKAY:
        score = Decimal("0.5")
    elif ratio < ASYMMETRY_POOR_HI:
        score = Decimal("-1.0")
    elif ratio < ASYMMETRY_POOR_LO:
        score = Decimal("-0.5")
    else:
        score = Decimal("0")
    return upside, downside, ratio, score


def days_to_estimated_earnings(
    today: datetime, financials: list[KrFinancialsRow]
) -> int | None:
    """Estimate days until the next quarterly report by walking forward
    from the latest ``period_end`` in 91-day steps. Returns ``None``
    when no period_end is available."""
    period_ends = [f.period_end for f in financials if f.period_end is not None]
    if not period_ends:
        return None
    latest = max(period_ends)
    today_date = today.date()
    delta_days = (today_date - latest).days
    if delta_days < 0:
        # latest period_end is in the future (rare data anomaly).
        return delta_days
    cycles_passed = delta_days // QUARTER_DAYS
    next_estimated_offset = (cycles_passed + 1) * QUARTER_DAYS
    return next_estimated_offset - delta_days


def severity_for(
    *, max_dd: Decimal, vol: Decimal, earnings_imminent: bool
) -> tuple[int, bool]:
    """Returns ``(severity, bumped)``.

    Severity walks SEVERITY_TABLE top-down and selects the first row
    whose drawdown AND vol thresholds are both met. If earnings are
    imminent and severity < 5, bump one step.
    """
    base = 1
    for dd_min, vol_min, sev in SEVERITY_TABLE:
        if max_dd >= dd_min and vol >= vol_min:
            base = sev
            break
    bumped = False
    if earnings_imminent and base < 5:
        base += 1
        bumped = True
    return base, bumped


def combine_risk_score(
    asymmetry: Decimal, skepticism: Decimal, unknowns: Decimal
) -> Decimal:
    """Sum then clamp into [-2, +2]."""
    raw = asymmetry + skepticism + unknowns
    return max(Decimal("-2.00"), min(Decimal("2.00"), raw)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


# ─── The character ───────────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "당신은 'Taleb'입니다. 나심 탈레브의 꼬리위험 철학으로 한국주식의 "
    "리스크를 평가합니다. 비대칭(상승/하락), 변동성, 어닝 임박 등 데이터로 "
    "검증된 위험만 인용하세요. 결정적 단어('매수', '매도', '강력 추천', "
    "'확정', '보장', '오늘 오른다', '오늘 내린다', '100%')는 절대 사용 "
    "금지. '하락 위험이 비대칭적으로 큽니다', '변동성이 평균을 크게 상회 "
    "합니다' 같은 회의적 어조만 사용. 시나리오는 반드시 데이터에 근거. "
    "응답은 반드시 다음 JSON 스키마: "
    "{\"narrative\": \"<200자 이내 한국어 위험 평가 + 1~3개 꼬리 시나리오>\"}"
)


class Taleb(Character):
    agent_name: ClassVar[AgentName] = "taleb"

    def fetch(self, ticker: str) -> TalebInputs:
        quotes = daily_quotes(ticker, days=LOOKBACK_DAYS)
        if len(quotes) < MIN_QUOTES_REQUIRED:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=(
                    f"{MIN_QUOTES_REQUIRED} trading-day closes required, "
                    f"got {len(quotes)}"
                ),
            )
        # latest_fundamentals isn't required — Taleb degrades gracefully
        # when fundamentals are missing (fine for new IPOs).
        _ = latest_fundamentals(ticker)
        financials = recent_financials(ticker, n=4)
        return TalebInputs(quotes=quotes, financials=financials)

    def analyze(
        self,
        ticker: str,
        cycle_at: datetime,
        inputs: TalebInputs | None = None,
    ) -> AgentOutputNew:
        bundle = inputs or self.fetch(ticker)

        vol = annualised_volatility(bundle.quotes)
        max_dd = max_drawdown_from_peak(bundle.quotes)
        upside, downside, ratio, asym_score = asymmetry_components(vol, max_dd)

        # Check 3 — earnings proximity.
        days_to_earn = days_to_estimated_earnings(cycle_at, bundle.financials)
        earnings_imminent = (
            days_to_earn is not None and days_to_earn <= EARNINGS_PROXIMITY_DAYS
        )
        unknowns_count = 1 if earnings_imminent else 0
        unknowns_score = -UNKNOWN_PENALTY * Decimal(unknowns_count)

        risk_score = combine_risk_score(
            asymmetry=asym_score,
            skepticism=Decimal("0"),  # M5+ wires this up.
            unknowns=unknowns_score,
        )

        severity, bumped = severity_for(
            max_dd=max_dd, vol=vol, earnings_imminent=earnings_imminent
        )

        payload = TalebPayload(
            annualised_vol=float(vol),
            max_drawdown=float(max_dd),
            upside_potential=float(upside),
            downside_risk=float(downside),
            asymmetry_ratio=float(ratio),
            asymmetry_score=float(asym_score),
            accuracy_lookup=None,
            data_skepticism_score=0.0,
            earnings_imminent=earnings_imminent,
            days_to_estimated_earnings=days_to_earn,
            unknowns_count=unknowns_count,
            unknowns_score=float(unknowns_score),
            severity=severity,
            severity_bumped_by_earnings=bumped,
            risk_score=float(risk_score),
            data_window_days=len(bundle.quotes),
        )

        narrative, model, cost = self._llm_narrative(
            ticker, payload, risk_score, severity
        )

        return AgentOutputNew(
            agent_name=self.agent_name,
            cycle_at=cycle_at,
            ticker=ticker,
            score=risk_score,
            severity=severity,
            narrative=narrative,
            raw_payload=payload.model_dump(),
            model=model,
            cost_estimate=cost,
        )

    # ── LLM ────────────────────────────────────────────────────────

    def _llm_narrative(
        self,
        ticker: str,
        payload: TalebPayload,
        score: Decimal,
        severity: int,
    ) -> tuple[str, str, float]:
        cache = [
            CacheBlock(
                text=_facts_block(ticker, payload, score, severity),
                label="taleb-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_SYSTEM_PROMPT,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 데이터로 {ticker} 종목의 위험 평가를 한국어 200자 "
                        "이내로 작성하세요. 비대칭·변동성·어닝 임박을 모두 "
                        "언급하고, 가장 그럴듯한 꼬리 시나리오 1~3개를 "
                        "데이터 근거와 함께 짧게 적으세요."
                    ),
                ),
            ],
            response_model=TalebLLMResponse,
        )
        if parsed is None:
            raise RuntimeError("call_claude returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        return narrative, result.model, result.cost_estimate_usd


def _facts_block(
    ticker: str, payload: TalebPayload, score: Decimal, severity: int
) -> str:
    lines = [
        f"종목: {ticker}",
        f"연환산 변동성: {payload.annualised_vol * 100:.1f}%",
        f"최대 낙폭(252일): {payload.max_drawdown * 100:.1f}%",
        f"상승여력: {payload.upside_potential * 100:.1f}%",
        f"하방위험: {payload.downside_risk * 100:.1f}%",
        f"비대칭 비율: {payload.asymmetry_ratio:.2f}",
        f"비대칭 점수: {payload.asymmetry_score:+.2f}",
        f"어닝 임박: {'예' if payload.earnings_imminent else '아니오'}"
        + (
            f" (D-{payload.days_to_estimated_earnings})"
            if payload.days_to_estimated_earnings is not None
            else ""
        ),
        f"미확인 위험 항목 수: {payload.unknowns_count}",
        f"risk_score: {score}",
        f"severity: {severity}/5"
        + (" (어닝으로 1단계 상향)" if payload.severity_bumped_by_earnings else ""),
        f"분석 데이터 일수: {payload.data_window_days}",
    ]
    return "\n".join(lines)
