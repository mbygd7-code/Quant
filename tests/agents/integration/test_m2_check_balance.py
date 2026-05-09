"""Integration: M2 check-and-balance dynamics across Graham + Dow → Soros.

These five scenarios pin the *behavioural* contract that M2's two-voter
synthesis is supposed to honour, using synthetic agent outputs crafted
to exercise each dynamic without hitting the DB or LLM:

    A. Strong bull consensus       → STRONG_BUY
    B. Strong bear consensus       → RISK
    C. Value-vs-trend conflict     → HOLD
    D. Trend dominates neutral G   → BUY
    E. Graham short on data        → cycle still emits Dow row + skips synth

Scenario E uses the cycle orchestrator (run_m2_cycle) directly, since
the partial-voter path lives there. Scenarios A–D operate at the
``Soros.synthesize`` level with hand-built voter rows.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from datetime import date as Date
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters._data import KrQuoteRow
from agents.characters.soros import (
    Soros,
    SorosInputs,
)
from agents.db.models import (
    AgentOutput,
    AgentOutputNew,
)
from agents.weights.constants import DEFAULT_WEIGHTS

CYCLE_AT = datetime(2026, 5, 9, 7, 0, tzinfo=UTC)


# ─── shared fixtures ────────────────────────────────────────────────


def _agent_output(agent: str, score: str, narrative: str = "ok") -> AgentOutput:
    return AgentOutput(
        id=uuid4(),
        agent_name=agent,  # type: ignore[arg-type]
        ticker="005930",
        cycle_at=CYCLE_AT,
        score=Decimal(score),
        severity=None,
        narrative=narrative,
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
        created_at=CYCLE_AT,
    )


def _quote(close: int = 60_000, days_back: int = 0) -> KrQuoteRow:
    return KrQuoteRow(
        date=Date(2026, 5, 9) - timedelta(days=days_back),
        ticker="005930",
        open=close - 100,
        high=close + 200,
        low=close - 200,
        close=close,
        volume=1_000_000,
        trading_value=close * 1_000_000,
        foreign_net_buy=0,
        change_rate=0.0,
    )


def _inputs(graham: AgentOutput, dow: AgentOutput) -> SorosInputs:
    weights = {
        agent: Decimal(str(getattr(DEFAULT_WEIGHTS, agent)))
        for agent in ("simons", "graham", "dow", "shiller", "keynes", "taleb")
    }
    return SorosInputs(
        graham=graham,
        dow=dow,
        weights=weights,
        recent_quotes=[_quote() for _ in range(30)],
        previous_signal=None,
    )


def _patch_llm(
    monkeypatch: pytest.MonkeyPatch,
    *,
    priced_in: float,
    narrative: str,
) -> None:
    """Stub Soros' two LLM calls — first returns priced_in, second
    returns the narrative. We're not testing the LLM here, only the
    arithmetic + grade mapping."""
    from agents.characters import soros as soros_mod
    from agents.llm.client import ClaudeResult

    call_count = {"n": 0}

    def fake_call(**kwargs: Any) -> tuple[ClaudeResult, Any]:
        call_count["n"] += 1
        if call_count["n"] == 1:
            parsed = soros_mod.SorosPricedIn(
                priced_in=priced_in,
                reason="시장 반영도 평가 결과 stub",
            )
        else:
            parsed = soros_mod.SorosNarrative(narrative=narrative)
        return (
            ClaudeResult(
                text="x",
                model="claude-test",
                input_tokens=10,
                output_tokens=10,
                cost_estimate_usd=0.0,
            ),
            parsed,
        )

    monkeypatch.setattr(soros_mod, "call_claude", fake_call)


# ─── A. strong bull consensus ───────────────────────────────────────


def test_a_strong_bull_consensus_yields_strong_buy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Graham +1.8 (deep value) and Dow +1.6 (strong uptrend) should
    converge on STRONG_BUY — the maximum-bullish band."""
    _patch_llm(
        monkeypatch,
        priced_in=0.30,  # below dampen threshold
        narrative="Graham과 Dow 모두 긍정적인 의견을 제시합니다.",
    )

    g = _agent_output("graham", "1.8", "본질가치 대비 안전마진 충분")
    d = _agent_output("dow", "1.6", "장기·중기·단기 추세 모두 정렬")
    s = Soros(repo=MagicMock())

    result = s.synthesize(
        ticker="005930",
        cycle_at=CYCLE_AT,
        graham=g,
        dow=d,
        inputs=_inputs(g, d),
    )

    sig = result.final_signal
    # Default weights are graham=0.18, dow=0.18 → 50/50 split.
    # Q1 = 0.5 × 1.8 + 0.5 × 1.6 = 1.70.
    assert sig.weighted_score == Decimal("1.70")
    assert sig.signal_grade == "STRONG_BUY"
    # confidence saturates at 1.0 (|1.70| / 2 = 0.85, not 1.0)
    assert sig.confidence == Decimal("0.85")


# ─── B. strong bear consensus ───────────────────────────────────────


def test_b_strong_bear_consensus_yields_risk(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Graham -1.8 (overvalued, weak quality) and Dow -1.6 (downtrend)
    should converge on RISK — the maximum-bearish band."""
    _patch_llm(
        monkeypatch,
        priced_in=0.30,
        narrative="Graham과 Dow 모두 부정적 신호를 보입니다.",
    )

    g = _agent_output("graham", "-1.8", "본질가치 대비 큰 폭 할증")
    d = _agent_output("dow", "-1.6", "장기 추세선 하방 이탈")
    s = Soros(repo=MagicMock())

    result = s.synthesize(
        ticker="005930",
        cycle_at=CYCLE_AT,
        graham=g,
        dow=d,
        inputs=_inputs(g, d),
    )

    sig = result.final_signal
    assert sig.weighted_score == Decimal("-1.70")
    assert sig.signal_grade == "RISK"


# ─── C. value-vs-trend conflict cancels out ─────────────────────────


def test_c_value_vs_trend_conflict_yields_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Classic check-and-balance: Graham screams 'cheap' (+1.8) while
    Dow screams 'falling knife' (-1.8). The 50/50 weighted average is
    0 → HOLD, the explicit "wait and see" band. This is the M2 design
    — neither voter wins; the signal honestly reports indecision."""
    _patch_llm(
        monkeypatch,
        priced_in=0.40,
        narrative=(
            "Graham은 안전마진을 강조하지만 Dow는 하락 추세를 경고합니다. "
            "두 의견이 충돌하므로 추가 확인이 필요합니다."
        ),
    )

    g = _agent_output("graham", "1.8", "본질가치 대비 큰 할인")
    d = _agent_output("dow", "-1.8", "장기 하락 추세 진행 중")
    s = Soros(repo=MagicMock())

    result = s.synthesize(
        ticker="005930",
        cycle_at=CYCLE_AT,
        graham=g,
        dow=d,
        inputs=_inputs(g, d),
    )

    sig = result.final_signal
    # Q1 = 0.5×1.8 + 0.5×(-1.8) = 0 → HOLD band (-0.30 ≤ 0 < 0.30).
    assert sig.weighted_score == Decimal("0.00")
    assert sig.signal_grade == "HOLD"


# ─── D. neutral Graham + bullish Dow → BUY ──────────────────────────


def test_d_trend_dominates_neutral_graham_yields_buy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Graham at 0 (fair value, ordinary quality) but Dow at +1.6
    (strong uptrend). The trend should drag the synthesis above the
    BUY threshold (+0.30) without crossing into STRONG_BUY (+1.00)."""
    _patch_llm(
        monkeypatch,
        priced_in=0.40,
        narrative="Graham은 중립적이나 Dow는 강한 추세를 보고합니다.",
    )

    g = _agent_output("graham", "0.0", "본질가치와 현재가 비슷")
    d = _agent_output("dow", "1.6", "장·중·단기 추세 정렬, 거래량 확인")
    s = Soros(repo=MagicMock())

    result = s.synthesize(
        ticker="005930",
        cycle_at=CYCLE_AT,
        graham=g,
        dow=d,
        inputs=_inputs(g, d),
    )

    sig = result.final_signal
    # Q1 = 0.5×0 + 0.5×1.6 = 0.80 → BUY (≥ 0.30, < 1.00)
    assert sig.weighted_score == Decimal("0.80")
    assert sig.signal_grade == "BUY"


# ─── D'. priced_in dampening flips BUY back to HOLD ─────────────────


def test_d_prime_priced_in_dampens_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the market has already absorbed the bull case (priced_in
    > 0.70), Soros halves the weighted score per character-soros.md
    §3 Q2. A 0.80 BUY then becomes 0.40 — still BUY, but closer to
    the HOLD threshold. This pins the dampening factor."""
    _patch_llm(
        monkeypatch,
        priced_in=0.85,  # above threshold → dampen
        narrative="시장이 이미 추세를 반영하여 신호 강도를 낮춥니다.",
    )

    g = _agent_output("graham", "0.0")
    d = _agent_output("dow", "1.6")
    s = Soros(repo=MagicMock())

    result = s.synthesize(
        ticker="005930",
        cycle_at=CYCLE_AT,
        graham=g,
        dow=d,
        inputs=_inputs(g, d),
    )

    sig = result.final_signal
    # Q1 = 0.80 → halved → 0.40 → still BUY.
    assert sig.weighted_score == Decimal("0.40")
    assert sig.signal_grade == "BUY"
    assert sig.weights_snapshot["priced_in_dampen_applied"] is True


# ─── E. partial voter — cycle preserves Dow when Graham raises ─────


def test_e_graham_insufficient_data_preserves_dow_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If Graham raises InsufficientDataError (e.g. no kr_fundamentals)
    the M2 cycle must still write Dow's agent_outputs row — partial
    data is useful for M1's per-character cards even when Soros can't
    synthesise. This pins the per-character isolation refactor."""
    from agents.cycle import run_m2_cycle as cycle_mod

    def graham_raises(self: Any, ticker: str, cycle_at: datetime) -> AgentOutputNew:
        raise InsufficientDataError(
            character="graham",
            ticker=ticker,
            reason="no kr_fundamentals row",
        )

    def dow_ok(self: Any, ticker: str, cycle_at: datetime) -> AgentOutputNew:
        return AgentOutputNew(
            agent_name="dow",
            cycle_at=cycle_at,
            ticker=ticker,
            score=Decimal("0.6"),
            narrative="장기 추세 양호",
            raw_payload={"trend_score_primary": 1, "trend_score_secondary": 1},
            model="claude-test",
            cost_estimate=0.0005,
        )

    monkeypatch.setattr(cycle_mod.Graham, "analyze", graham_raises)
    monkeypatch.setattr(cycle_mod.Dow, "analyze", dow_ok)

    inserted: list[str] = []

    repo = MagicMock()

    def record_insert(out: AgentOutputNew) -> AgentOutput:
        inserted.append(out.agent_name)
        return _agent_output(out.agent_name, str(out.score), out.narrative)

    repo.insert_agent_output.side_effect = record_insert
    repo.insert_final_signal.return_value = MagicMock(id=uuid4())

    report = cycle_mod.run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930"],
        repo=repo,
    )

    # Dow's row IS persisted even though Graham failed. Synth is skipped.
    assert "dow" in inserted
    assert "graham" not in inserted
    assert report.skipped == 1
    assert report.errors == 0
    skipped = report.outcomes[0]
    assert skipped.status == "skipped"
    assert "graham=" in (skipped.error or "")
