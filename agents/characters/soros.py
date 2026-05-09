"""Soros — desk head, signal synthesizer.

M2 ships a *limited* Soros that aggregates Graham + Dow only. M3 adds
Shiller + Keynes; M4 adds Taleb + the auto-constraint; M5 adds Simons.

Soros is structurally different from Graham / Dow:
  * It doesn't fetch market data — it consumes other characters'
    outputs (already in agent_outputs at the same cycle_at) plus a
    light recent-quote window for the priced-in heuristic.
  * It writes to ``final_signals`` + ``signal_change_events`` rather
    than ``agent_outputs`` (the row that records the *signal*, not a
    voting opinion).
  * It calls Claude twice: once for Q2 (priced-in score, 0..1) and
    once for the synthesis narrative.

Algorithm (M2 limited):

  Q1. weighted_score = g_share × graham.score + d_share × dow.score
        where g_share + d_share = 1.0, derived from user weights:
        g_share = user.graham / (user.graham + user.dow)

  Q2. priced_in ∈ [0, 1] from a Claude call given recent price
        action + agent narratives. > 0.7 → halve weighted_score.

  Q3. (M4+) Taleb auto-constraint. M2 just passes through with
        taleb_severity=null and taleb_override=False.

  signal_grade = scoreToSignalGrade(adjusted_score)
  confidence  = abs(adjusted_score) / 2.0

  if last grade for this ticker differs from new grade:
      append signal_change_events row with reason='agent_consensus_shift'
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import ClassVar
from uuid import UUID

from pydantic import BaseModel, Field

from agents.characters._data import KrQuoteRow, daily_quotes
from agents.db.models import (
    AgentName,
    AgentOutput,
    FinalSignal,
    FinalSignalNew,
    SignalChangeEventNew,
    SignalGrade,
    UserWeightSettings,
)
from agents.db.repository import AgentRepository, get_agent_repository
from agents.grading import score_to_signal_grade
from agents.llm import (
    CacheBlock,
    ClaudeMessage,
    call_claude,
    sanitize_narrative,
)
from agents.weights.constants import DEFAULT_WEIGHTS

#: M2 weight set narrowed to two voting characters. M3 expands.
M2_VOTERS: tuple[AgentName, ...] = ("graham", "dow")

#: Priced-in threshold above which we halve the weighted_score (per
#: character-soros.md §3 Q2 — "이미 반영된 만큼 신호 약화").
PRICED_IN_DAMPEN_THRESHOLD = Decimal("0.70")
PRICED_IN_DAMPEN_FACTOR = Decimal("0.5")


# ─── Synthesis dataclasses ──────────────────────────────────────────


@dataclass(frozen=True)
class SorosInputs:
    """Pre-fetched bundle for the synthesis call."""

    graham: AgentOutput
    dow: AgentOutput
    weights: dict[AgentName, Decimal]   # M2: only graham + dow consulted
    recent_quotes: list[KrQuoteRow]     # last ~30 days for priced-in eval
    previous_signal: FinalSignal | None  # for change-event detection


class SorosPricedIn(BaseModel):
    """Q2 LLM response — priced-in score in [0, 1]."""

    priced_in: float = Field(ge=0, le=1)
    reason: str = Field(min_length=5)


class SorosNarrative(BaseModel):
    """Final synthesis narrative."""

    narrative: str = Field(min_length=10)


@dataclass(frozen=True)
class SynthesisResult:
    """Everything Soros produced this cycle, ready for the orchestrator
    to persist."""

    final_signal: FinalSignalNew
    change_event: SignalChangeEventNew | None
    cost_estimate_usd: float


# ─── Pure-function helpers ──────────────────────────────────────────


def m2_voter_shares(weights: dict[AgentName, Decimal]) -> dict[AgentName, Decimal]:
    """Re-normalise the M2 voters' weights to sum 1.0 across them.

    Example: user has graham=0.18, dow=0.18 → both get 0.5.
    Edge case: if both are zero, fall back to a 50/50 split.
    """
    g = weights.get("graham", Decimal(0))
    d = weights.get("dow", Decimal(0))
    total = g + d
    if total == 0:
        return {"graham": Decimal("0.5"), "dow": Decimal("0.5")}
    return {
        "graham": (g / total).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP),
        "dow": (d / total).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP),
    }


def weighted_q1_score(
    graham_score: Decimal | None,
    dow_score: Decimal | None,
    shares: dict[AgentName, Decimal],
) -> Decimal:
    """Weighted sum of the two M2 voters. Either side may be None when
    its character couldn't score (e.g. PER+PBR both missing); we treat
    a missing side as a zero contribution and let the other voter
    carry the full weight."""
    g = graham_score if graham_score is not None else Decimal(0)
    d = dow_score if dow_score is not None else Decimal(0)
    return (shares["graham"] * g + shares["dow"] * d).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def apply_priced_in(score: Decimal, priced_in: Decimal) -> Decimal:
    """Halve the score when priced_in > 0.70.

    Below the threshold, pass through unchanged. The 0.5 dampen factor
    matches character-soros.md §3 Q2; the threshold can be tuned in
    future without changing the call site.
    """
    if priced_in > PRICED_IN_DAMPEN_THRESHOLD:
        return (score * PRICED_IN_DAMPEN_FACTOR).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
    return score.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def confidence_from_score(score: Decimal) -> Decimal:
    """abs(score) / 2.0 mapped into [0, 1] with two decimals."""
    raw = abs(score) / Decimal(2)
    return min(Decimal(1), max(Decimal(0), raw)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def detect_grade_change(
    previous: FinalSignal | None, new_grade: SignalGrade
) -> tuple[SignalGrade | None, bool]:
    """Returns ``(from_grade, did_change)``.

    ``from_grade`` is None when there's no previous signal for the
    ticker, in which case we still emit a change event with the M1
    schema's nullable ``from_grade``.
    """
    if previous is None:
        return None, True
    if previous.signal_grade == new_grade:
        return previous.signal_grade, False
    return previous.signal_grade, True


# ─── System prompts ─────────────────────────────────────────────────


_PRICED_IN_SYSTEM = (
    "당신은 'Soros'입니다. 시장이 데이터를 이미 가격에 얼마나 반영했는지 "
    "0~1로 평가합니다. 0=시장이 무관심, 1=완전히 반영됨. "
    "최근 가격 모멘텀, 거래량 변화, 다른 분석가 의견을 종합해 판단합니다. "
    "응답은 반드시 다음 JSON 스키마: "
    "{\"priced_in\": 0.0~1.0, \"reason\": \"<한국어 한 문장>\"}"
)

_NARRATIVE_SYSTEM = (
    "당신은 'Soros'입니다. 데스크 헤드로서 다른 분석가(M2: Graham, Dow)의 "
    "의견을 종합하고 자신의 결론을 한국어로 명확히 전달합니다. "
    "결정적 단어('매수', '매도', '강력 추천', '확정', '보장', '오늘 오른다', "
    "'오늘 내린다', '100%')를 절대 사용하지 마세요. "
    "두 분석가의 의견을 모두 인용하되 (\"Graham은 ... Dow는 ...\"), "
    "동의 또는 견제 구도를 명확히 하고, 시장 반영도(priced_in)와 함께 "
    "자신의 판단을 제시하세요. 응답은 반드시 다음 JSON 스키마: "
    "{\"narrative\": \"<200자 이내 한국어 종합 평가>\"}"
)


# ─── Soros class ─────────────────────────────────────────────────────


class Soros:
    """Desk head. Distinct from Character ABC — its analyze API takes
    other characters' outputs rather than raw market data."""

    agent_name: ClassVar[AgentName] = "soros"

    def __init__(self, repo: AgentRepository | None = None) -> None:
        self.repo = repo or get_agent_repository()

    # ── Fetch helpers ──────────────────────────────────────────────

    def _user_weights(self, user_id: UUID | None) -> dict[AgentName, Decimal]:
        """Look up a user's voting weights or fall back to defaults.

        M2 only consults graham + dow; the broader set is preserved
        for forward compatibility.
        """
        if user_id is None:
            bundle = DEFAULT_WEIGHTS
        else:
            row: UserWeightSettings | None = self.repo.get_user_weights(user_id)
            bundle = row.weights if row else DEFAULT_WEIGHTS
        return {
            agent: Decimal(str(getattr(bundle, agent)))
            for agent in ("simons", "graham", "dow", "shiller", "keynes", "taleb")
        }

    def _previous_signal(self, ticker: str) -> FinalSignal | None:
        return self.repo.latest_final_signal(ticker)

    def fetch(
        self,
        ticker: str,
        graham: AgentOutput,
        dow: AgentOutput,
        *,
        user_id: UUID | None = None,
    ) -> SorosInputs:
        weights = self._user_weights(user_id)
        recent = daily_quotes(ticker, days=30)
        return SorosInputs(
            graham=graham,
            dow=dow,
            weights=weights,
            recent_quotes=recent,
            previous_signal=self._previous_signal(ticker),
        )

    # ── Synthesis ─────────────────────────────────────────────────

    def synthesize(
        self,
        ticker: str,
        cycle_at: datetime,
        graham: AgentOutput,
        dow: AgentOutput,
        *,
        user_id: UUID | None = None,
        inputs: SorosInputs | None = None,
    ) -> SynthesisResult:
        bundle = inputs or self.fetch(
            ticker, graham, dow, user_id=user_id
        )

        shares = m2_voter_shares(bundle.weights)
        q1 = weighted_q1_score(
            graham_score=bundle.graham.score,
            dow_score=bundle.dow.score,
            shares=shares,
        )

        priced_in, q2_cost, _q2_model = self._priced_in_score(
            ticker, bundle
        )
        adjusted = apply_priced_in(q1, priced_in)

        # Q3: Taleb constraint deferred to M4. M2 emits null severity.
        signal_grade = score_to_signal_grade(adjusted)
        confidence = confidence_from_score(adjusted)

        narrative, narr_cost, _narr_model = self._narrative(
            ticker, bundle, q1, priced_in, adjusted, signal_grade
        )

        weights_snapshot = {
            "graham_share": float(shares["graham"]),
            "dow_share": float(shares["dow"]),
            "raw_user_weights": {k: float(v) for k, v in bundle.weights.items()},
            "priced_in": float(priced_in),
            "priced_in_dampen_applied": priced_in > PRICED_IN_DAMPEN_THRESHOLD,
            "q1_score": float(q1),
            "q2_adjusted_score": float(adjusted),
        }

        new_signal = FinalSignalNew(
            ticker=ticker,
            cycle_at=cycle_at,
            signal_grade=signal_grade,
            confidence=confidence,
            weighted_score=adjusted,
            weights_snapshot=weights_snapshot,
            narrative=narrative,
            taleb_severity=None,
            taleb_override=False,
            cost_estimate=q2_cost + narr_cost,
        )

        from_grade, did_change = detect_grade_change(
            bundle.previous_signal, signal_grade
        )
        change_event: SignalChangeEventNew | None = None
        if did_change:
            change_event = SignalChangeEventNew(
                ticker=ticker,
                from_grade=from_grade,
                to_grade=signal_grade,
                from_signal_id=(
                    bundle.previous_signal.id if bundle.previous_signal else None
                ),
                # to_signal_id is filled in by the orchestrator after
                # the final_signals insert returns its uuid. Use a
                # placeholder UUID here; the orchestrator overwrites
                # before the change-event row is inserted.
                to_signal_id=UUID("00000000-0000-0000-0000-000000000000"),
                reason="agent_consensus_shift",
                taleb_override=False,
            )

        return SynthesisResult(
            final_signal=new_signal,
            change_event=change_event,
            cost_estimate_usd=q2_cost + narr_cost,
        )

    # ── LLM calls ─────────────────────────────────────────────────

    def _priced_in_score(
        self, ticker: str, bundle: SorosInputs
    ) -> tuple[Decimal, float, str]:
        """Q2 — ask Claude to read recent price action + agent narratives
        and return a 0..1 score.

        Returns ``(priced_in, cost_usd, model_id)``.
        """
        cache = [
            CacheBlock(
                text=_priced_in_facts(ticker, bundle),
                label="soros-priced-in-facts",
            ),
        ]
        result, parsed = call_claude(
            system=_PRICED_IN_SYSTEM,
            cache=cache,
            messages=[
                ClaudeMessage(
                    role="user",
                    content=(
                        f"위 데이터로 {ticker}의 priced_in 점수를 계산하세요. "
                        "최근 가격이 분석가들의 의견을 이미 반영했는지 평가합니다."
                    ),
                ),
            ],
            response_model=SorosPricedIn,
        )
        if parsed is None:
            raise RuntimeError("priced-in call returned no parsed response")
        return (
            Decimal(str(parsed.priced_in)).quantize(Decimal("0.01")),
            result.cost_estimate_usd,
            result.model,
        )

    def _narrative(
        self,
        ticker: str,
        bundle: SorosInputs,
        q1: Decimal,
        priced_in: Decimal,
        adjusted: Decimal,
        grade: SignalGrade,
    ) -> tuple[str, float, str]:
        cache = [
            CacheBlock(
                text=(
                    f"Graham 의견({bundle.graham.score:+}점):\n{bundle.graham.narrative}"
                ),
                label="graham-narrative",
            ),
            CacheBlock(
                text=(
                    f"Dow 의견({bundle.dow.score:+}점):\n{bundle.dow.narrative}"
                ),
                label="dow-narrative",
            ),
        ]
        user_text = (
            f"{ticker} 종합:\n"
            f"- Q1 가중 합산 점수: {q1}\n"
            f"- Q2 priced_in: {priced_in}  → 적용된 점수: {adjusted}\n"
            f"- 산출 시그널: {grade}\n"
            "두 분석가 의견을 인용하며 결론을 작성하세요."
        )
        result, parsed = call_claude(
            system=_NARRATIVE_SYSTEM,
            cache=cache,
            messages=[ClaudeMessage(role="user", content=user_text)],
            response_model=SorosNarrative,
        )
        if parsed is None:
            raise RuntimeError("narrative call returned no parsed response")
        narrative = sanitize_narrative(parsed.narrative.strip())
        return narrative, result.cost_estimate_usd, result.model


def _priced_in_facts(ticker: str, bundle: SorosInputs) -> str:
    closes = [q.close for q in bundle.recent_quotes[:30] if q.close is not None]
    if len(closes) >= 2:
        first = closes[-1]
        last = closes[0]
        change_pct = (last - first) / first * 100 if first else 0
    else:
        change_pct = 0
    vols = [q.volume for q in bundle.recent_quotes[:20] if q.volume is not None]
    avg_vol = sum(vols) / len(vols) if vols else 0
    recent_vol = sum(vols[:5]) / 5 if len(vols) >= 5 else avg_vol
    vol_ratio = recent_vol / avg_vol if avg_vol else 0
    return "\n".join([
        f"종목: {ticker}",
        f"최근 30일 가격 변동: {change_pct:+.2f}%",
        f"최근 5일 거래량 / 20일 평균: {vol_ratio:.2f}",
        f"Graham 점수: {bundle.graham.score}",
        f"Graham narrative: {bundle.graham.narrative}",
        f"Dow 점수: {bundle.dow.score}",
        f"Dow narrative: {bundle.dow.narrative}",
    ])
