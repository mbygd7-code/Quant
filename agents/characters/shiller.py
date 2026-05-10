"""Shiller — market cycle analyst.

M3 simplification — full PE10 + 7-component fear-greed + narrative
tracking is heavy. Ship a 5-component proxy that uses what's
already in the legacy pipeline:

  Component 1. Momentum   KOSPI close vs 200-day MA → percentile
  Component 2. Volatility ^VIX 20-day average → fear/greed band
  Component 3. Valuation  Watchlist median forward_pe → percentile
  Component 4. Foreign    5-day cumulative foreign net buy across watchlist
  Component 5. Breadth    Fraction of watchlist with close > MA60

  fear_greed_index = mean(components)        ∈ [0, 100]
  regime stage:
    0..20    "극단적 공포 (Capitulation)"   market_score +2.0
    20..40   "회복 (Recovery)"               market_score +1.0
    40..60   "정상 (Normal)"                 market_score  0.0
    60..80   "과열 (Greed)"                  market_score -1.0
    80..100  "극단적 탐욕 (Mania)"          market_score -2.0

Per-ticker score:
  ticker_pe_modifier from where the ticker's forward_pe sits among
  the watchlist median (low PE = +0.3, high PE = -0.3, neutral = 0).
  per_ticker_score = clamp(market_score × 0.7 + modifier, -2, +2)

Score calculation is fully deterministic — the LLM call is reserved
for the narrative.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import ClassVar

from pydantic import BaseModel, Field

from agents.characters._base import Character, InsufficientDataError
from agents.characters._data import (
    GlobalMarketRow,
    KrFundamentalsRow,
    KrQuoteRow,
    daily_quotes,
    global_quotes,
    latest_fundamentals,
    watchlist_fundamentals,
)
from agents.db.models import AgentName, AgentOutputNew
from agents.llm import (
    CacheBlock,
    ClaudeMessage,
    call_claude,
    sanitize_narrative_safe,
)

# ─── Tunables ───────────────────────────────────────────────────────

#: Minimum length of the KOSPI series we need to compute MA200 + the
#: 252-day percentile band.
MIN_INDEX_QUOTES = 200

#: Volatility band edges (^VIX 20d average): below = greed, above = fear.
VIX_GREED_CEILING = 12.0
VIX_FEAR_FLOOR = 30.0

#: Per-ticker PE modifier — small enough that the market regime
#: dominates the score but large enough to differentiate among the
#: 50 watchlist names.
PE_MODIFIER_LOW = Decimal("0.30")
PE_MODIFIER_HIGH = Decimal("-0.30")

#: How much of the per-ticker score comes from the market regime vs
#: the ticker's own PE position.
MARKET_WEIGHT = Decimal("0.7")


REGIME_BANDS: tuple[tuple[int, str, Decimal], ...] = (
    (20, "극단적 공포 (Capitulation)", Decimal("2.0")),
    (40, "회복 (Recovery)", Decimal("1.0")),
    (60, "정상 (Normal)", Decimal("0")),
    (80, "과열 (Greed)", Decimal("-1.0")),
    (101, "극단적 탐욕 (Mania)", Decimal("-2.0")),  # 101 so the >=80 case still maps
)


# ─── Inputs / outputs ───────────────────────────────────────────────


@dataclass(frozen=True)
class MarketRegimeInputs:
    kospi: list[GlobalMarketRow]                  # newest-first ≥200
    vix: list[GlobalMarketRow]                    # newest-first ≥20
    watchlist_fundamentals: list[KrFundamentalsRow]
    watchlist_recent_quotes: dict[str, list[KrQuoteRow]]  # newest-first


@dataclass(frozen=True)
class FearGreedComponents:
    momentum: float       # 0..100
    volatility: float     # 0..100
    valuation: float      # 0..100
    foreign: float        # 0..100
    breadth: float        # 0..100

    @property
    def index(self) -> float:
        return (
            self.momentum
            + self.volatility
            + self.valuation
            + self.foreign
            + self.breadth
        ) / 5


@dataclass(frozen=True)
class MarketRegime:
    fear_greed_index: float
    components: FearGreedComponents
    stage_label: str
    market_score: Decimal  # -2..+2


class ShillerPayload(BaseModel):
    fear_greed_index: float = Field(ge=0, le=100)
    momentum: float = Field(ge=0, le=100)
    volatility: float = Field(ge=0, le=100)
    valuation: float = Field(ge=0, le=100)
    foreign: float = Field(ge=0, le=100)
    breadth: float = Field(ge=0, le=100)
    stage_label: str
    market_score: float
    ticker_pe: float | None
    watchlist_median_pe: float | None
    pe_modifier: float
    per_ticker_score: float


class ShillerLLMResponse(BaseModel):
    narrative: str = Field(min_length=10)


# ─── Pure-function calculators ──────────────────────────────────────


def _percentile_in_distribution(value: float, sample: list[float]) -> float:
    """Return the percentile (0..100) of ``value`` against ``sample``.

    Uses simple rank position (no interpolation) because the inputs
    are noisy enough that bilinear refinement adds no signal.
    """
    if not sample:
        return 50.0
    sorted_vals = sorted(sample)
    below = sum(1 for v in sorted_vals if v < value)
    return (below / len(sorted_vals)) * 100


def momentum_score(kospi: list[GlobalMarketRow]) -> float:
    """200-day momentum: where the close sits in the trailing 252-day
    distribution. Higher percentile = greedier market."""
    closes = [row.close for row in kospi if row.close is not None]
    if len(closes) < MIN_INDEX_QUOTES:
        raise InsufficientDataError(
            character="shiller",
            ticker="<market>",
            reason=f"need ≥{MIN_INDEX_QUOTES} KOSPI closes, got {len(closes)}",
        )
    current = closes[0]
    history = closes[: min(252, len(closes))]
    return _percentile_in_distribution(current, history)


def volatility_score(vix: list[GlobalMarketRow]) -> float:
    """^VIX-derived band: low VIX = greed (high score), high VIX =
    fear (low score). Linear ramp between greed-ceiling and fear-floor.
    Returns ``50.0`` (neutral) when no VIX data is available — common
    for the M2 → M3 transition window."""
    closes = [row.close for row in vix[:20] if row.close is not None]
    if not closes:
        return 50.0
    avg20 = sum(closes) / len(closes)
    if avg20 <= VIX_GREED_CEILING:
        return 100.0
    if avg20 >= VIX_FEAR_FLOOR:
        return 0.0
    # Linear interpolation between greed ceiling (100) and fear floor (0).
    span = VIX_FEAR_FLOOR - VIX_GREED_CEILING
    pos = avg20 - VIX_GREED_CEILING
    return 100.0 - (pos / span) * 100.0


def valuation_score(funds: list[KrFundamentalsRow]) -> float:
    """Where the watchlist's *median* forward PE sits in the
    distribution of recent fundamentals. Higher PE → greedier market.

    Uses ``forward_pe`` (collector default); falls back to
    ``trailing_pe`` row-by-row when forward is missing.
    """
    pes: list[float] = []
    for f in funds:
        v = f.forward_pe if f.forward_pe is not None else f.trailing_pe
        if v is not None and v > 0:
            pes.append(v)
    if len(pes) < 5:
        return 50.0  # too few names — neutral
    median = statistics.median(pes)
    return _percentile_in_distribution(median, pes)


def foreign_score(quotes_by_ticker: dict[str, list[KrQuoteRow]]) -> float:
    """5-day cumulative foreign net-buy across the watchlist.
    Map: net buy → greed, net sell → fear. Bounds chosen so a
    ±50 trillion KRW total swing maps to the band edges (typical
    monthly variation in KRW is in the trillions; 5d in tens of
    trillions is rare but not impossible)."""
    total_5d = 0
    for quotes in quotes_by_ticker.values():
        for q in quotes[:5]:
            if q.foreign_net_buy is not None:
                total_5d += q.foreign_net_buy
    # Saturate at ±5 trillion (5e12 KRW). Linear in between.
    saturation = 5_000_000_000_000
    bounded = max(-saturation, min(saturation, total_5d))
    return 50.0 + (bounded / saturation) * 50.0


def breadth_score(quotes_by_ticker: dict[str, list[KrQuoteRow]]) -> float:
    """Fraction of the watchlist whose latest close sits above their
    own 60-day MA. Higher = greedier."""
    above = 0
    counted = 0
    for quotes in quotes_by_ticker.values():
        if len(quotes) < 60:
            continue
        latest = quotes[0].close
        ma60_inputs = [q.close for q in quotes[:60] if q.close is not None]
        if latest is None or not ma60_inputs:
            continue
        ma60 = sum(ma60_inputs) / len(ma60_inputs)
        if latest > ma60:
            above += 1
        counted += 1
    if counted == 0:
        return 50.0
    return (above / counted) * 100.0


def assess_market_regime(inputs: MarketRegimeInputs) -> MarketRegime:
    """Pure function: deterministic regime + score from the inputs."""
    components = FearGreedComponents(
        momentum=momentum_score(inputs.kospi),
        volatility=volatility_score(inputs.vix),
        valuation=valuation_score(inputs.watchlist_fundamentals),
        foreign=foreign_score(inputs.watchlist_recent_quotes),
        breadth=breadth_score(inputs.watchlist_recent_quotes),
    )
    fg = components.index
    for upper, label, score in REGIME_BANDS:
        if fg < upper:
            return MarketRegime(
                fear_greed_index=fg,
                components=components,
                stage_label=label,
                market_score=score,
            )
    # Defensive — should be unreachable given REGIME_BANDS uses 101 sentinel.
    return MarketRegime(
        fear_greed_index=fg,
        components=components,
        stage_label=REGIME_BANDS[-1][1],
        market_score=REGIME_BANDS[-1][2],
    )


def pe_modifier(
    ticker_pe: float | None, watchlist_pes: list[float]
) -> Decimal:
    """+0.30 when the ticker's PE is below the watchlist median,
    -0.30 above, 0 within ±10% of median or when data is missing."""
    if ticker_pe is None or ticker_pe <= 0 or len(watchlist_pes) < 5:
        return Decimal("0")
    median = statistics.median(watchlist_pes)
    if median <= 0:
        return Decimal("0")
    ratio = ticker_pe / median
    if ratio < 0.9:
        return PE_MODIFIER_LOW
    if ratio > 1.1:
        return PE_MODIFIER_HIGH
    return Decimal("0")


def per_ticker_score(
    market_score: Decimal, pe_mod: Decimal
) -> Decimal:
    """clamp(market × 0.7 + pe_modifier, -2.00, +2.00)."""
    raw = (market_score * MARKET_WEIGHT) + pe_mod
    bounded = max(Decimal("-2.00"), min(Decimal("2.00"), raw))
    return bounded.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


# ─── Character ─────────────────────────────────────────────────────


_SYSTEM_PROMPT = (
    "당신은 'Shiller'입니다. 시장 사이클 분석가로서 *지금 시장이 어디쯤* "
    "와 있는지 5단계(극단적 공포/회복/정상/과열/극단적 탐욕)로 진단합니다. "
    "결정적 단어('매수', '매도', '강력 추천', '확정', '보장', '오늘 오른다', "
    "'오늘 내린다', '100%')를 절대 사용하지 마세요. 회의적·역사적 어투를 "
    "선호합니다 — '지금의 시장은 X와 닮은 점이 있습니다', '평균 회귀까지는 "
    "시간이 걸립니다'. 응답은 반드시 다음 JSON 스키마: "
    "{\"narrative\": \"<150자 이내 한국어 평가>\"}"
)


@dataclass(frozen=True)
class ShillerInputs:
    """Pre-fetched bundle so tests can skip the DB."""

    market: MarketRegimeInputs
    ticker_fundamentals: KrFundamentalsRow | None


class Shiller(Character):
    agent_name: ClassVar[AgentName] = "shiller"

    def fetch(self, ticker: str) -> ShillerInputs:
        kospi = global_quotes("^KS11", days=260)
        if len([k for k in kospi if k.close is not None]) < MIN_INDEX_QUOTES:
            raise InsufficientDataError(
                character=self.agent_name,
                ticker=ticker,
                reason=(
                    f"need ≥{MIN_INDEX_QUOTES} KOSPI quotes in global_market, "
                    f"got {len(kospi)}"
                ),
            )
        vix = global_quotes("^VIX", days=20)
        funds = watchlist_fundamentals()

        watch_quotes: dict[str, list[KrQuoteRow]] = {}
        for f in funds:
            watch_quotes[f.ticker] = daily_quotes(f.ticker, days=60)

        market_inputs = MarketRegimeInputs(
            kospi=kospi,
            vix=vix,
            watchlist_fundamentals=funds,
            watchlist_recent_quotes=watch_quotes,
        )

        ticker_funds = latest_fundamentals(ticker)
        return ShillerInputs(
            market=market_inputs, ticker_fundamentals=ticker_funds
        )

    def analyze(
        self,
        ticker: str,
        cycle_at: datetime,
        inputs: ShillerInputs | None = None,
    ) -> AgentOutputNew:
        bundle = inputs or self.fetch(ticker)
        regime = assess_market_regime(bundle.market)

        watchlist_pes: list[float] = []
        for f in bundle.market.watchlist_fundamentals:
            v = f.forward_pe if f.forward_pe is not None else f.trailing_pe
            if v is not None and v > 0:
                watchlist_pes.append(v)
        median_pe = statistics.median(watchlist_pes) if watchlist_pes else None
        ticker_pe = (
            bundle.ticker_fundamentals.forward_pe
            or (bundle.ticker_fundamentals.trailing_pe if bundle.ticker_fundamentals else None)
            if bundle.ticker_fundamentals
            else None
        )
        pe_mod = pe_modifier(ticker_pe, watchlist_pes)
        score = per_ticker_score(regime.market_score, pe_mod)

        payload = ShillerPayload(
            fear_greed_index=regime.fear_greed_index,
            momentum=regime.components.momentum,
            volatility=regime.components.volatility,
            valuation=regime.components.valuation,
            foreign=regime.components.foreign,
            breadth=regime.components.breadth,
            stage_label=regime.stage_label,
            market_score=float(regime.market_score),
            ticker_pe=ticker_pe,
            watchlist_median_pe=median_pe,
            pe_modifier=float(pe_mod),
            per_ticker_score=float(score),
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

    # ── LLM ───────────────────────────────────────────────────────

    def _llm_narrative(
        self,
        ticker: str,
        payload: ShillerPayload,
        score: Decimal,
    ) -> tuple[str, str, float]:
        cache = [
            CacheBlock(
                text=_facts_block(ticker, payload, score),
                label="shiller-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_SYSTEM_PROMPT,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 데이터로 {ticker} 종목에 대한 Shiller 관점의 평가를 "
                        "한국어 150자 이내로 작성하세요. 시장 단계와 종목의 "
                        "워치리스트 내 PE 위치를 모두 언급하되, 매매 권유 표현은 "
                        "사용하지 마세요."
                    ),
                ),
            ],
            response_model=ShillerLLMResponse,
        )
        if parsed is None:
            raise RuntimeError("call_claude returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        return narrative, result.model, result.cost_estimate_usd


def _facts_block(ticker: str, payload: ShillerPayload, score: Decimal) -> str:
    return "\n".join([
        f"종목: {ticker}",
        f"공포·탐욕 지수: {payload.fear_greed_index:.1f} / 100",
        f"  - 모멘텀(KOSPI): {payload.momentum:.1f}",
        f"  - 변동성(VIX):   {payload.volatility:.1f}",
        f"  - 밸류에이션:    {payload.valuation:.1f}",
        f"  - 외국인 5일:    {payload.foreign:.1f}",
        f"  - 브레드스:      {payload.breadth:.1f}",
        f"시장 단계: {payload.stage_label}  (score {payload.market_score:+})",
        f"종목 forward_pe: {payload.ticker_pe}",
        f"워치리스트 중앙값 forward_pe: {payload.watchlist_median_pe}",
        f"PE 보정: {payload.pe_modifier:+.2f}",
        f"산출 점수: {score}",
    ])
