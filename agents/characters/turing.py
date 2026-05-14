"""Turing — pure-technical pattern recognizer.

Three orthogonal technical signals combined into a single -2..+2 score:

  1. **RSI(14)** — momentum mean-reversion.
     • RSI < 30 → oversold, +0.7
     • RSI > 70 → overbought, -0.7
     • Linear elsewhere.
  2. **MACD(12,26,9)** — trend confirmation.
     • signal-line crossover direction × abs(histogram)/atr, clipped ±0.6.
  3. **Bollinger %b(20,2σ)** — position-in-band.
     • %b < 0 → outside lower, +0.5  (mean-reversion entry)
     • %b > 1 → outside upper, -0.5  (overextended)
     • 0..1   → 0  (inside band, no signal)

The three are summed and clipped to [-2.00, +2.00]. The narrative is
LLM-generated (Claude) but the score is fully deterministic — same
pattern as Graham/Dow.

No new collectors needed: this voter reads ``korea_market`` close +
volume that all other voters already use.
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
    sanitize_narrative_safe,
)

# ─── Tunable constants ─────────────────────────────────────────────

#: RSI period — 14 is the Wilder default. Shorter (e.g. 9) is noisier.
RSI_PERIOD = 14
#: MACD parameters — 12/26/9 are the classic Appel defaults.
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIGNAL = 9
#: Bollinger window + sigma.
BB_PERIOD = 20
BB_SIGMA = Decimal("2.0")

#: Minimum quote rows required to compute MACD signal — slow + signal.
MIN_QUOTES = MACD_SLOW + MACD_SIGNAL  # 35

#: Score-band caps for each component (kept small so combined ≤ ±1.8 and
#: combined with quality boost still fits the ±2 contract).
RSI_MAX = Decimal("0.7")
MACD_MAX = Decimal("0.6")
BB_MAX = Decimal("0.5")


@dataclass(frozen=True)
class TuringInputs:
    quotes: list[KrQuoteRow]  # newest first, ≥ MIN_QUOTES expected


@dataclass(frozen=True)
class TechnicalBreakdown:
    rsi: Decimal | None
    macd_hist: Decimal | None
    macd_signal_dir: int  # -1 / 0 / +1
    bb_percent_b: Decimal | None
    rsi_score: Decimal
    macd_score: Decimal
    bb_score: Decimal


class TuringPayload(BaseModel):
    rsi_14: float | None
    macd_histogram: float | None
    macd_signal_direction: int  # -1 / 0 / +1
    bb_percent_b: float | None
    rsi_score: float
    macd_score: float
    bb_score: float
    data_window_days: int


class TuringLLMResponse(BaseModel):
    narrative: str = Field(min_length=10)


# ─── Pure-function calculators ──────────────────────────────────────


def rsi_14(closes: list[float]) -> float | None:
    """Wilder's RSI(14). `closes` is newest-first. Returns None if too short."""
    if len(closes) < RSI_PERIOD + 1:
        return None
    # Work oldest-first for the rolling average.
    series = list(reversed(closes))
    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, len(series)):
        diff = series[i] - series[i - 1]
        gains.append(max(diff, 0.0))
        losses.append(max(-diff, 0.0))
    # Initial averages: simple mean of first RSI_PERIOD diffs.
    avg_gain = sum(gains[:RSI_PERIOD]) / RSI_PERIOD
    avg_loss = sum(losses[:RSI_PERIOD]) / RSI_PERIOD
    # Subsequent values: Wilder's smoothing (alpha = 1/period).
    for i in range(RSI_PERIOD, len(gains)):
        avg_gain = (avg_gain * (RSI_PERIOD - 1) + gains[i]) / RSI_PERIOD
        avg_loss = (avg_loss * (RSI_PERIOD - 1) + losses[i]) / RSI_PERIOD
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _ema(series: list[float], period: int) -> list[float]:
    """EMA series (newest last)."""
    if len(series) < period:
        return []
    alpha = 2.0 / (period + 1)
    out = [sum(series[:period]) / period]
    for v in series[period:]:
        out.append(alpha * v + (1 - alpha) * out[-1])
    return out


def macd(closes: list[float]) -> tuple[float, float, int] | None:
    """Return (histogram, signal_line_value, direction) or None.

    `closes` is newest-first. Direction: +1 if histogram crossed above
    zero on the most recent bar, -1 if below, 0 otherwise.
    """
    if len(closes) < MIN_QUOTES:
        return None
    series = list(reversed(closes))
    fast = _ema(series, MACD_FAST)
    slow = _ema(series, MACD_SLOW)
    # Align tails — `fast` is longer.
    offset = len(fast) - len(slow)
    fast = fast[offset:]
    macd_line = [f - s for f, s in zip(fast, slow)]
    signal = _ema(macd_line, MACD_SIGNAL)
    if not signal:
        return None
    # Align macd to signal length.
    macd_tail = macd_line[-len(signal):]
    hist = [m - s for m, s in zip(macd_tail, signal)]
    last_hist = hist[-1]
    prev_hist = hist[-2] if len(hist) >= 2 else 0.0
    direction = 0
    if prev_hist <= 0 < last_hist:
        direction = 1
    elif prev_hist >= 0 > last_hist:
        direction = -1
    return (last_hist, signal[-1], direction)


def bollinger_percent_b(closes: list[float]) -> float | None:
    """Bollinger %b on the most recent close (newest-first input)."""
    if len(closes) < BB_PERIOD:
        return None
    window = closes[:BB_PERIOD]
    mean = sum(window) / BB_PERIOD
    var = sum((c - mean) ** 2 for c in window) / BB_PERIOD
    std = var ** 0.5
    if std == 0:
        return 0.5  # flat → mid-band
    sigma = float(BB_SIGMA)
    upper = mean + sigma * std
    lower = mean - sigma * std
    last = closes[0]
    return (last - lower) / (upper - lower)


# ─── Score mappers ──────────────────────────────────────────────────


def rsi_to_score(rsi: float | None) -> Decimal:
    """Map RSI 0..100 → score ±RSI_MAX. Oversold → positive (mean revert up)."""
    if rsi is None:
        return Decimal("0")
    if rsi <= 30:
        return RSI_MAX
    if rsi >= 70:
        return -RSI_MAX
    # Linear between 30..70 → +RSI_MAX..-RSI_MAX
    pct = (rsi - 30) / 40  # 0..1
    return (RSI_MAX * (Decimal("1") - Decimal("2") * Decimal(str(pct)))).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP,
    )


def macd_to_score(hist: float | None, direction: int) -> Decimal:
    """Map MACD histogram + crossover direction → score ±MACD_MAX.

    Direction provides the sign; magnitude scaled by |hist| but capped.
    A fresh upward crossover with small histogram still gives a useful
    +0.3 prior; a runaway negative histogram caps at -0.6.
    """
    if hist is None:
        return Decimal("0")
    if direction == 0:
        # No fresh crossover — half-weight by histogram sign alone.
        sign = 1 if hist > 0 else -1 if hist < 0 else 0
        return (Decimal(sign) * MACD_MAX / Decimal("2")).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP,
        )
    magnitude = min(Decimal("1.0"), Decimal(str(abs(hist))) / Decimal("100"))
    return (Decimal(direction) * MACD_MAX * magnitude).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP,
    )


def bb_to_score(percent_b: float | None) -> Decimal:
    """Map %b → score ±BB_MAX. Outside lower band → +, outside upper → -."""
    if percent_b is None:
        return Decimal("0")
    if percent_b < 0:
        return BB_MAX
    if percent_b > 1:
        return -BB_MAX
    return Decimal("0")  # inside band — no edge signal


def combine_score(rsi_s: Decimal, macd_s: Decimal, bb_s: Decimal) -> Decimal:
    """Sum the three components, clipped to the ±2 contract."""
    total = rsi_s + macd_s + bb_s
    clipped = max(Decimal("-2.00"), min(Decimal("2.00"), total))
    return clipped.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ─── The character ───────────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "당신은 'Turing'입니다. 순수 수학적 패턴 인식으로 한국주식을 분석합니다. "
    "RSI, MACD, 볼린저밴드 등 기술지표만으로 모멘텀과 평균회귀 신호를 추출합니다. "
    "결정적 단어('매수', '매도', '강력 추천', '확정', '보장', '100%')를 "
    "절대 사용하지 마세요. '모멘텀이 강화되는 구간입니다', "
    "'기술적 과매수 영역에 진입했습니다' 같은 패턴 서술만 사용하세요. "
    "응답은 반드시 다음 JSON 스키마로만: {\"narrative\": \"<120자 이내 한국어>\"}"
)


class Turing(Character):
    agent_name: ClassVar[AgentName] = "turing"

    def fetch(self, ticker: str) -> TuringInputs:
        quotes = daily_quotes(ticker, days=120)  # plenty of headroom
        if len(quotes) < MIN_QUOTES:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=f"need ≥{MIN_QUOTES} daily quotes, got {len(quotes)}",
            )
        return TuringInputs(quotes=quotes)

    def analyze(
        self,
        ticker: str,
        cycle_at: datetime,
        inputs: TuringInputs | None = None,
    ) -> AgentOutputNew:
        bundle = inputs or self.fetch(ticker)
        # Newest-first closes (skip None — IPOs / circuit-breaker days).
        closes = [
            float(q.close) for q in bundle.quotes if q.close is not None
        ]
        if len(closes) < MIN_QUOTES:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=f"need ≥{MIN_QUOTES} valid closes, got {len(closes)}",
            )

        rsi_v = rsi_14(closes)
        macd_out = macd(closes)
        bb_v = bollinger_percent_b(closes)

        macd_hist, _macd_sig, macd_dir = macd_out if macd_out else (None, None, 0)

        rsi_s = rsi_to_score(rsi_v)
        macd_s = macd_to_score(macd_hist, macd_dir)
        bb_s = bb_to_score(bb_v)
        score = combine_score(rsi_s, macd_s, bb_s)

        payload = TuringPayload(
            rsi_14=rsi_v,
            macd_histogram=macd_hist,
            macd_signal_direction=macd_dir,
            bb_percent_b=bb_v,
            rsi_score=float(rsi_s),
            macd_score=float(macd_s),
            bb_score=float(bb_s),
            data_window_days=len(closes),
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

    def _llm_narrative(
        self,
        ticker: str,
        payload: TuringPayload,
        score: Decimal,
    ) -> tuple[str, str, float]:
        cache = [
            CacheBlock(
                text=_facts_block(ticker, payload, score),
                label="turing-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_SYSTEM_PROMPT,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 기술지표 수치로 {ticker}의 단기 패턴을 "
                        "120자 이내로 서술하세요. 모멘텀(MACD), 과매수/과매도(RSI), "
                        "밴드 위치(Bollinger %b)를 모두 언급하되 매매 권유는 사용하지 마세요."
                    ),
                ),
            ],
            response_model=TuringLLMResponse,
        )
        if parsed is None:
            raise RuntimeError("call_claude returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        return narrative, result.model, result.cost_estimate_usd


def _facts_block(ticker: str, payload: TuringPayload, score: Decimal) -> str:
    lines = [
        f"종목: {ticker}",
        f"RSI(14): {payload.rsi_14:.1f}" if payload.rsi_14 is not None else "RSI(14): —",
        f"MACD 히스토그램: {payload.macd_histogram:+.2f}"
            if payload.macd_histogram is not None else "MACD 히스토그램: —",
        f"MACD 크로스오버: {payload.macd_signal_direction:+d}",
        f"볼린저 %b: {payload.bb_percent_b:.2f}"
            if payload.bb_percent_b is not None else "볼린저 %b: —",
        f"RSI 점수: {payload.rsi_score:+.2f}",
        f"MACD 점수: {payload.macd_score:+.2f}",
        f"Bollinger 점수: {payload.bb_score:+.2f}",
        f"산출 점수: {score}",
        f"분석 일자 수: {payload.data_window_days}",
    ]
    return "\n".join(lines)
