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
from agents.grading import (
    apply_confidence_gate,
    apply_taleb_constraint,
    score_to_signal_grade,
)
from agents.llm import (
    CacheBlock,
    ClaudeMessage,
    call_claude,
    sanitize_narrative_safe,
)
from agents.weights.constants import DEFAULT_WEIGHTS

#: M2 weight set narrowed to two voting characters. M3 expands.
M2_VOTERS: tuple[AgentName, ...] = ("graham", "dow")

#: M3 voter set — Graham + Dow + Shiller + Keynes. M4 adds Taleb,
#: M5 adds Simons, completing the six.
M3_VOTERS: tuple[AgentName, ...] = ("graham", "dow", "shiller", "keynes")

#: M4 voter set — adds Taleb and Turing. Taleb's risk_score participates
#: in Q1 and Taleb's severity drives the Q3 auto-constraint after Q2.
#:
#: Turing (RSI/MACD/Bollinger) was computed, persisted and shown in the
#: UI from day one but was MISSING from this tuple, so its vote carried
#: zero weight in every final signal (found in the 2026-06-10 audit).
#: It votes through the "simons" weight slot — see _user_weights.
M4_VOTERS: tuple[AgentName, ...] = (
    "graham", "dow", "turing", "shiller", "keynes", "taleb",
)

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


@dataclass(frozen=True)
class SorosInputsM3:
    """Pre-fetched bundle for the M3 four-voter synthesis call."""

    voters: dict[AgentName, AgentOutput]  # graham, dow, shiller, keynes
    weights: dict[AgentName, Decimal]
    recent_quotes: list[KrQuoteRow]
    previous_signal: FinalSignal | None


class SorosPricedIn(BaseModel):
    """Q2 LLM response — priced-in score in [0, 1]."""

    priced_in: float = Field(ge=0, le=1)
    reason: str = Field(min_length=5)


class SorosNarrative(BaseModel):
    """Final synthesis narrative.

    Optional time-horizon fields (`short_term`, `mid_term`) let Soros
    produce concrete 1-week and 1-month forecasts in addition to the
    headline narrative — mirrors the legacy ``ai_commentary`` schema's
    short_term/mid_term columns so the UI's analyst-report layout
    (verdict + 단기 + 중기 + catalysts/risks) has data to render.

    When the LLM omits these (older cache hits, parse failures), the
    UI falls back to showing only the headline + the auto-extracted
    voter quotes.
    """

    narrative: str = Field(min_length=10)
    short_term: str | None = Field(
        default=None,
        description="1주 단기 전망. 모멘텀·수급·이벤트 일정 위주.",
    )
    mid_term: str | None = Field(
        default=None,
        description="1개월 중기 전망. 펀더멘털·사이클·매크로 누적 효과.",
    )


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


def voter_shares_for(
    weights: dict[AgentName, Decimal],
    voters: tuple[AgentName, ...],
) -> dict[AgentName, Decimal]:
    """Generic voter-share normaliser — works for any subset of the
    six voting agents. Used by M3 (4 voters) and beyond.

    Falls back to an even split if the requested voters all have zero
    weight (defensive — shouldn't happen with the validator's 5%-40%
    floor, but safer than div-by-zero).
    """
    if not voters:
        return {}
    raw = {v: weights.get(v, Decimal(0)) for v in voters}
    total = sum(raw.values(), Decimal(0))
    if total == 0:
        share = (Decimal(1) / Decimal(len(voters))).quantize(
            Decimal("0.0001"), rounding=ROUND_HALF_UP
        )
        return dict.fromkeys(voters, share)
    return {
        v: (raw[v] / total).quantize(Decimal("0.0001"), rounding=ROUND_HALF_UP)
        for v in voters
    }


def weighted_q1_score_generic(
    scores: dict[AgentName, Decimal | None],
    shares: dict[AgentName, Decimal],
) -> Decimal:
    """Generalised Q1: weighted sum across an arbitrary voter set.

    Missing scores (None) contribute zero — same convention as the
    M2 helper. The caller is responsible for matching keys.
    """
    total = Decimal(0)
    for agent, share in shares.items():
        s = scores.get(agent)
        if s is None:
            continue
        total += share * s
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


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
    """Legacy `abs(score) / 2` — kept for M2/M3 paths that don't have
    voter context yet. New code should prefer `confidence_from_voters`
    which measures actual disagreement instead of restating magnitude.
    """
    raw = abs(score) / Decimal(2)
    return min(Decimal(1), max(Decimal(0), raw)).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )


def confidence_from_voters(
    voter_scores: dict[AgentName, Decimal],
    adjusted_score: Decimal,
) -> Decimal:
    """Measure voter agreement, not signal magnitude.

    The previous `confidence_from_score` returned `abs(score)/2`, which is
    just a rescaling of the headline number — it could never tell you
    "1 voter at +2, 4 voters at 0" apart from "5 voters at +0.4 each".
    Both have the same weighted score, but the second case is a much
    more trustworthy bullish signal.

    Formula:
      1. dispersion = stdev(voter_scores)           (≥0, capped at 1.0 in practice)
      2. directional = fraction of voters in same direction as adjusted_score
      3. confidence = 0.5·directional + 0.5·(1 − min(1, dispersion/1.0))

    With 5 voters all at +1 → dispersion 0, directional 1.0 → confidence 1.0
    With 1 at +2, 4 at 0 → dispersion ~0.89, directional 0.20 → confidence ~0.16
    With 3 at +0.5, 2 at -0.5 → dispersion ~0.55, directional 0.60 → confidence ~0.52
    """
    scores = [float(s) for s in voter_scores.values()]
    if not scores:
        return Decimal("0")
    n = len(scores)

    # 1. Standard deviation of voter scores (population, not sample —
    #    n is small and we just want a dispersion proxy).
    mean = sum(scores) / n
    variance = sum((s - mean) ** 2 for s in scores) / n
    stdev = variance ** 0.5

    # 2. Directional agreement: fraction of voters whose sign matches
    #    the final adjusted score. Voters at exactly 0 don't count
    #    against directional agreement — they're abstentions.
    target_sign = 1 if float(adjusted_score) > 0 else -1 if float(adjusted_score) < 0 else 0
    if target_sign == 0:
        directional = 0.5  # neutral signal, any voter direction is fine
    else:
        non_zero = [s for s in scores if abs(s) > 0.05]
        if not non_zero:
            directional = 0.0
        else:
            agreeing = sum(1 for s in non_zero if (s > 0) == (target_sign > 0))
            directional = agreeing / len(non_zero)

    # 3. Compose. Stdev > 1.0 is rare with our ±2 contract; cap so it
    #    doesn't produce negative confidence.
    dispersion_term = max(0.0, 1.0 - min(1.0, stdev / 1.0))
    conf = 0.5 * directional + 0.5 * dispersion_term
    return Decimal(str(conf)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


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

_NARRATIVE_SYSTEM_M4 = (
    "당신은 'Soros'입니다. 데스크 헤드로서 5명 분석가(Graham, Dow, "
    "Shiller, Keynes, Taleb)의 의견을 종합합니다. 결정적 단어('매수', "
    "'매도', '강력 추천', '확정', '보장', '오늘 오른다', '오늘 내린다', "
    "'100%')를 절대 사용하지 마세요. 다섯 분석가 의견을 모두 인용하고 "
    "(이름 명시), Taleb의 risk_score와 severity를 별도로 다루세요. "
    "Taleb이 severity 4 이상을 발행했다면 자동 제약 적용 여부를 명시. "
    "응답은 반드시 다음 JSON 스키마:\n"
    "{\n"
    "  \"narrative\": \"<300자 이내 한국어 종합 평가 — 분석가별 인용 + 최종 시그널 결론>\",\n"
    "  \"short_term\": \"<1주 단기 전망 (80~120자). 모멘텀·수급·이벤트 일정 중심. "
    "비교형 표현만 사용하고 매매 권유 금지>\",\n"
    "  \"mid_term\": \"<1개월 중기 전망 (80~120자). 펀더멘털·사이클·매크로 누적 효과 중심. "
    "비교형 표현만 사용하고 매매 권유 금지>\"\n"
    "}"
)

_NARRATIVE_SYSTEM_M3 = (
    "당신은 'Soros'입니다. 데스크 헤드로서 4명 분석가(Graham, Dow, "
    "Shiller, Keynes)의 의견을 종합합니다. 결정적 단어('매수', '매도', "
    "'강력 추천', '확정', '보장', '오늘 오른다', '오늘 내린다', '100%')를 "
    "절대 사용하지 마세요. 네 분석가의 의견을 모두 인용하고 (이름 명시), "
    "각 견제축(가치-추세, 시장사이클-매크로)에서 누가 동의하고 누가 반대하는지 "
    "명확히 한 뒤 자신의 결론을 제시하세요. priced_in 영향도 함께 언급. "
    "응답은 반드시 다음 JSON 스키마: "
    "{\"narrative\": \"<250자 이내 한국어 종합 평가>\"}"
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
        weights = {
            agent: Decimal(str(getattr(bundle, agent)))
            for agent in ("graham", "dow", "shiller", "keynes", "taleb")
        }
        # The "simons" slot is the quant/technical seat in the 6-agent
        # weight bundle (UI sliders, user_weight_settings JSON). Simons
        # was never implemented — Turing (RSI/MACD/Bollinger) fills that
        # role in M4, so the slot's weight flows to Turing's vote. Keeps
        # existing user rows (e.g. simons=0.25) meaningful without a
        # DB/JSON migration. If a real Simons lands in M5+, split the
        # slot then.
        weights["turing"] = Decimal(str(bundle.simons))
        return weights

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

    # ── M3 synthesis (4 voters: Graham, Dow, Shiller, Keynes) ─────

    def fetch_m3(
        self,
        ticker: str,
        voters: dict[AgentName, AgentOutput],
        *,
        user_id: UUID | None = None,
    ) -> SorosInputsM3:
        weights = self._user_weights(user_id)
        recent = daily_quotes(ticker, days=30)
        return SorosInputsM3(
            voters=voters,
            weights=weights,
            recent_quotes=recent,
            previous_signal=self._previous_signal(ticker),
        )

    def synthesize_m3(
        self,
        ticker: str,
        cycle_at: datetime,
        voters: dict[AgentName, AgentOutput],
        *,
        user_id: UUID | None = None,
        inputs: SorosInputsM3 | None = None,
    ) -> SynthesisResult:
        """Generalised four-voter synthesis. ``voters`` keys must be
        a subset of M3_VOTERS; missing voters drop out of the weighted
        sum (their share is redistributed proportionally)."""
        bundle = inputs or self.fetch_m3(ticker, voters, user_id=user_id)

        present = tuple(a for a in M3_VOTERS if a in bundle.voters)
        shares = voter_shares_for(bundle.weights, present)
        scores = {a: bundle.voters[a].score for a in present}
        q1 = weighted_q1_score_generic(scores, shares)

        priced_in, q2_cost, _q2_model = self._priced_in_score_m3(
            ticker, bundle
        )
        adjusted = apply_priced_in(q1, priced_in)

        signal_grade = score_to_signal_grade(adjusted)
        confidence = confidence_from_score(adjusted)

        narrative, narr_cost, _narr_model = self._narrative_m3(
            ticker, bundle, q1, priced_in, adjusted, signal_grade
        )

        weights_snapshot = {
            "shares": {a: float(shares[a]) for a in present},
            "raw_user_weights": {k: float(v) for k, v in bundle.weights.items()},
            "voter_set": list(present),
            "priced_in": float(priced_in),
            "priced_in_dampen_applied": priced_in > PRICED_IN_DAMPEN_THRESHOLD,
            "q1_score": float(q1),
            "q2_adjusted_score": float(adjusted),
            "milestone": "M3",
        }

        new_signal = FinalSignalNew(
            ticker=ticker,
            cycle_at=cycle_at,
            signal_grade=signal_grade,
            confidence=confidence,
            weighted_score=adjusted,
            weights_snapshot=weights_snapshot,
            narrative=narrative,
            taleb_severity=None,    # M4 wires Taleb
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
                to_signal_id=UUID("00000000-0000-0000-0000-000000000000"),
                reason="agent_consensus_shift",
                taleb_override=False,
            )

        return SynthesisResult(
            final_signal=new_signal,
            change_event=change_event,
            cost_estimate_usd=q2_cost + narr_cost,
        )

    def _priced_in_score_m3(
        self, ticker: str, bundle: SorosInputsM3
    ) -> tuple[Decimal, float, str]:
        cache = [
            CacheBlock(
                text=_priced_in_facts_m3(ticker, bundle),
                label="soros-m3-priced-in",
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

    def _narrative_m3(
        self,
        ticker: str,
        bundle: SorosInputsM3,
        q1: Decimal,
        priced_in: Decimal,
        adjusted: Decimal,
        grade: SignalGrade,
    ) -> tuple[str, float, str]:
        # Single combined cache block — see _narrative_m4 for why (Anthropic
        # caps cache_control blocks at 4; M3's 4 voters sat exactly at the
        # edge and any extra block would 400).
        voter_sections = [
            f"{agent_name.capitalize()} 의견 ({output.score:+}점):\n{output.narrative}"
            for agent_name, output in bundle.voters.items()
        ]
        cache: list[CacheBlock] = [
            CacheBlock(text="\n\n".join(voter_sections), label="m3-voters")
        ]
        voter_lines = "\n".join(
            f"- {a}: {bundle.voters[a].score}점"
            for a in bundle.voters
        )
        # priced_in dampening direction guidance — without this hint the
        # LLM frequently calls a dampening "상향 조정" because the final
        # absolute number can sit at a notable threshold like 1.00.
        dampened = priced_in > PRICED_IN_DAMPEN_THRESHOLD
        direction_note = (
            "priced_in이 임계(0.70)를 초과해 점수가 절반으로 감쇠됐습니다 (×0.5 적용). "
            "narrative에서 '상향' 같은 증폭 표현을 쓰지 마세요."
            if dampened
            else "priced_in이 임계 미만이므로 감쇠 없이 그대로 통과됐습니다."
        )
        user_text = (
            f"{ticker} 종합 (M3 — 4명 투표):\n"
            f"{voter_lines}\n"
            f"- Q1 가중 합산 점수: {q1}\n"
            f"- Q2 priced_in: {priced_in}  → 적용된 점수: {adjusted}\n"
            f"- {direction_note}\n"
            f"- 산출 시그널: {grade}\n"
            "네 분석가 의견을 인용하며 결론을 작성하세요. "
            "동의·견제 구도를 명확히 하세요."
        )
        result, parsed = call_claude(
            system=_NARRATIVE_SYSTEM_M3,
            cache=cache,
            messages=[ClaudeMessage(role="user", content=user_text)],
            response_model=SorosNarrative,
            max_tokens=2048,  # same truncation guard as M4 (see _narrative_m4)
        )
        if parsed is None:
            raise RuntimeError("M3 narrative returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        return narrative, result.cost_estimate_usd, result.model

    # ── M4 synthesis (5 voters: + Taleb auto-constraint) ─────────

    def synthesize_m4(
        self,
        ticker: str,
        cycle_at: datetime,
        voters: dict[AgentName, AgentOutput],
        *,
        user_id: UUID | None = None,
        inputs: SorosInputsM3 | None = None,
    ) -> SynthesisResult:
        """Five-voter synthesis with Q3 Taleb auto-constraint.

        Pipeline:
          Q1   weighted sum across {graham, dow, shiller, keynes, taleb}
          Q2   priced-in dampening (same as M2/M3)
          Q3   if voters['taleb'].severity >= 4, apply_taleb_constraint
               downgrades the baseline grade (severity 4 = -1 step;
               severity 5 = STRONG_BUY/BUY → HOLD).

        ``taleb_severity`` is recorded on the FinalSignal so the M1
        grade-stamping UI can render the badge. ``taleb_override`` stays
        False — the override flag is reserved for the case where the
        user manually rejects Taleb's constraint (M5+ feature).
        """
        bundle = inputs or self.fetch_m3(ticker, voters, user_id=user_id)

        present = tuple(a for a in M4_VOTERS if a in bundle.voters)
        shares = voter_shares_for(bundle.weights, present)
        scores = {a: bundle.voters[a].score for a in present}
        q1 = weighted_q1_score_generic(scores, shares)

        priced_in, q2_cost, _q2_model = self._priced_in_score_m3(
            ticker, bundle
        )
        adjusted = apply_priced_in(q1, priced_in)

        baseline_grade = score_to_signal_grade(adjusted)

        # Voter-agreement confidence — replaces the legacy |score|/2
        # version so '강한 관심 with 50% 신뢰도' (1 voter strong, 4
        # neutral) gets correctly demoted by the gate below.
        confidence = confidence_from_voters(scores, adjusted)

        # Q4 — confidence gate. Demote STRONG_BUY/BUY when voter
        # agreement is weak. Runs BEFORE Taleb so the dual override
        # path is: confidence gate → Taleb constraint, with both
        # recorded in weights_snapshot for audit.
        gated_grade, gate_applied = apply_confidence_gate(
            baseline_grade, confidence
        )

        # Q3 — Taleb auto-constraint on the gated grade.
        taleb_out = bundle.voters.get("taleb")
        taleb_severity = taleb_out.severity if taleb_out is not None else None
        signal_grade, constraint_applied = apply_taleb_constraint(
            gated_grade, taleb_severity
        )

        narrative, narr_cost, _narr_model, short_term, mid_term = self._narrative_m4(
            ticker,
            bundle,
            q1,
            priced_in,
            adjusted,
            baseline_grade,
            signal_grade,
            taleb_severity,
            constraint_applied,
        )

        # `active_voters` = voters whose |score| ≥ 0.1 — used as an audit
        # field so we can spot single-voter-driven signals retrospectively.
        # The confidence gate (Phase A) is the runtime guard; this column
        # makes the post-hoc analysis cheaper than re-running the cycle.
        active_voters = [
            a for a in present if abs(float(scores[a])) >= 0.1
        ]

        weights_snapshot = {
            "shares": {a: float(shares[a]) for a in present},
            "raw_user_weights": {k: float(v) for k, v in bundle.weights.items()},
            "voter_set": list(present),
            "active_voters": active_voters,
            "active_voter_count": len(active_voters),
            "priced_in": float(priced_in),
            "priced_in_dampen_applied": priced_in > PRICED_IN_DAMPEN_THRESHOLD,
            "q1_score": float(q1),
            "q2_adjusted_score": float(adjusted),
            "baseline_grade": baseline_grade,
            "gated_grade": gated_grade,
            "confidence_gate_applied": gate_applied,
            "taleb_severity": taleb_severity,
            "taleb_constraint_applied": constraint_applied,
            "short_term": short_term,
            "mid_term": mid_term,
            "milestone": "M4",
        }

        new_signal = FinalSignalNew(
            ticker=ticker,
            cycle_at=cycle_at,
            signal_grade=signal_grade,
            confidence=confidence,
            weighted_score=adjusted,
            weights_snapshot=weights_snapshot,
            narrative=narrative,
            taleb_severity=taleb_severity,
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
                to_signal_id=UUID("00000000-0000-0000-0000-000000000000"),
                reason=(
                    "taleb_auto_constraint"
                    if constraint_applied
                    else "agent_consensus_shift"
                ),
                taleb_override=False,
            )

        return SynthesisResult(
            final_signal=new_signal,
            change_event=change_event,
            cost_estimate_usd=q2_cost + narr_cost,
        )

    def _narrative_m4(
        self,
        ticker: str,
        bundle: SorosInputsM3,
        q1: Decimal,
        priced_in: Decimal,
        adjusted: Decimal,
        baseline: SignalGrade,
        final_grade: SignalGrade,
        taleb_severity: int | None,
        constraint_applied: bool,
    ) -> tuple[str, float, str]:
        # Single combined cache block. One block PER voter (6 of them in M4)
        # exceeds Anthropic's hard limit of 4 cache_control blocks → 400
        # "A maximum of 4 blocks with cache_control may be provided. Found 6."
        # which silently killed synthesis for every ticker whose full voter
        # set was present. Concatenating into one block keeps the prompt-cache
        # benefit while staying at 1 cache_control block.
        voter_sections: list[str] = []
        for agent_name, output in bundle.voters.items():
            severity_suffix = (
                f" severity={output.severity}"
                if output.severity is not None
                else ""
            )
            voter_sections.append(
                f"{agent_name.capitalize()} 의견 "
                f"({output.score:+}점{severity_suffix}):\n"
                f"{output.narrative}"
            )
        cache: list[CacheBlock] = [
            CacheBlock(text="\n\n".join(voter_sections), label="m4-voters")
        ]
        voter_lines = "\n".join(
            f"- {a}: {bundle.voters[a].score}점"
            + (
                f" (severity {bundle.voters[a].severity})"
                if bundle.voters[a].severity is not None
                else ""
            )
            for a in bundle.voters
        )
        constraint_line = (
            f"- Q3 Taleb 자동 제약: {baseline} → {final_grade} "
            f"(severity {taleb_severity})"
            if constraint_applied
            else (
                f"- Q3 Taleb 자동 제약: 미적용 (severity "
                f"{taleb_severity if taleb_severity is not None else '없음'})"
            )
        )
        dampened = priced_in > PRICED_IN_DAMPEN_THRESHOLD
        direction_note = (
            "priced_in이 임계(0.70)를 초과해 점수가 절반으로 감쇠됐습니다 (×0.5 적용). "
            "narrative에서 '상향' 같은 증폭 표현을 쓰지 마세요."
            if dampened
            else "priced_in이 임계 미만이므로 감쇠 없이 그대로 통과됐습니다."
        )
        user_text = (
            f"{ticker} 종합 (M4 — 5명 투표):\n"
            f"{voter_lines}\n"
            f"- Q1 가중 합산 점수: {q1}\n"
            f"- Q2 priced_in: {priced_in} → 적용 점수: {adjusted}\n"
            f"- {direction_note}\n"
            f"- 산출 기본 시그널: {baseline}\n"
            f"{constraint_line}\n"
            f"- 최종 시그널: {final_grade}\n"
            "다섯 분석가 의견을 모두 인용하며 결론을 작성하세요. "
            "Taleb의 risk_score와 severity를 별도로 다루세요."
        )
        result, parsed = call_claude(
            system=_NARRATIVE_SYSTEM_M4,
            cache=cache,
            messages=[ClaudeMessage(role="user", content=user_text)],
            response_model=SorosNarrative,
            # narrative(≤300자) + short_term(≤120자) + mid_term(≤120자) in a
            # JSON envelope is ~1.0-1.4k output tokens. The 1024 default
            # truncated the JSON mid-string → parse failure → this method
            # raised for ~97% of tickers (only naturally-concise outputs
            # fit). 2048 gives comfortable headroom.
            max_tokens=2048,
        )
        if parsed is None:
            raise RuntimeError("M4 narrative returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        short_term = (
            sanitize_narrative_safe(parsed.short_term.strip())
            if parsed.short_term else None
        )
        mid_term = (
            sanitize_narrative_safe(parsed.mid_term.strip())
            if parsed.mid_term else None
        )
        # Pack the time-horizon forecasts into the narrative envelope —
        # the caller stores them in weights_snapshot so no schema change
        # is needed. UI parses these back out of the snapshot.
        return (
            narrative,
            result.cost_estimate_usd,
            result.model,
            short_term,
            mid_term,
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
            max_tokens=2048,  # same truncation guard as M4 (see _narrative_m4)
        )
        if parsed is None:
            raise RuntimeError("narrative call returned no parsed response")
        narrative = sanitize_narrative_safe(parsed.narrative.strip())
        return narrative, result.cost_estimate_usd, result.model


def _priced_in_facts_m3(ticker: str, bundle: SorosInputsM3) -> str:
    """Same shape as the M2 helper but reads from the M3 voter dict.

    Lists every present voter's score + narrative so the priced-in
    LLM can weigh consensus / dissent against recent price action.
    """
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
    lines = [
        f"종목: {ticker}",
        f"최근 30일 가격 변동: {change_pct:+.2f}%",
        f"최근 5일 거래량 / 20일 평균: {vol_ratio:.2f}",
    ]
    for agent_name, output in bundle.voters.items():
        lines.append(f"{agent_name} 점수: {output.score}")
        lines.append(f"{agent_name} narrative: {output.narrative}")
    return "\n".join(lines)


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
