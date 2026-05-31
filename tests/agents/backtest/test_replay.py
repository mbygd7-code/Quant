"""Smoke test for the replay loop.

Avoids the live DB and LLM: every character's ``analyze`` is stubbed
to return a deterministic AgentOutputNew, and Soros' two LLM calls
are stubbed via the same monkey-patch pattern as the M4 integration
tests. The point is to verify the *plumbing* — CSV schema, idempotent
resume, cost-budget cap — not the algorithms (which have their own
tests).
"""
from __future__ import annotations

import csv
from datetime import UTC, datetime
from datetime import date as Date
from decimal import Decimal
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from agents.backtest import replay_m4 as replay_mod
from agents.db.models import AgentOutputNew


def _stub_output_new(
    agent: str, score: str, severity: int | None = None
) -> AgentOutputNew:
    return AgentOutputNew(
        agent_name=agent,  # type: ignore[arg-type]
        cycle_at=datetime(2026, 4, 9, 7, 0, tzinfo=UTC),
        ticker="005930",
        score=Decimal(score),
        severity=severity,
        narrative="stub narrative used in unit test",
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
    )


def _patch_characters_and_soros(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Replace each character's analyze() with a deterministic stub
    and Soros' LLM calls with stub parsers."""
    from agents.characters import soros as soros_mod
    from agents.llm.client import ClaudeResult

    # Deterministic per-character outputs — bullish primaries + low
    # severity Taleb so the cycle finishes through synthesize_m4.
    by_agent = {
        "graham": ("1.5", None),
        "dow": ("1.4", None),
        "shiller": ("0.8", None),
        "keynes": ("0.6", None),
        "taleb": ("-0.3", 2),
    }

    def make_stub(agent: str) -> Any:
        def fake_analyze(
            self: Any, ticker: str, cycle_at: datetime
        ) -> AgentOutputNew:
            score, severity = by_agent[agent]
            return AgentOutputNew(
                agent_name=agent,  # type: ignore[arg-type]
                cycle_at=cycle_at,
                ticker=ticker,
                score=Decimal(score),
                severity=severity,
                narrative=f"{agent} stub for {ticker}",
                raw_payload={},
                model="claude-test",
                cost_estimate=0.001,
            )
        return fake_analyze

    monkeypatch.setattr(replay_mod.Graham, "analyze", make_stub("graham"))
    monkeypatch.setattr(replay_mod.Dow, "analyze", make_stub("dow"))
    monkeypatch.setattr(replay_mod.Shiller, "analyze", make_stub("shiller"))
    monkeypatch.setattr(replay_mod.Keynes, "analyze", make_stub("keynes"))
    monkeypatch.setattr(replay_mod.Taleb, "analyze", make_stub("taleb"))

    # Stub Soros' two LLM calls (priced_in + narrative).
    call_count = {"n": 0}

    def fake_call(**kwargs: Any) -> tuple[ClaudeResult, Any]:
        call_count["n"] += 1
        if call_count["n"] % 2 == 1:
            parsed = soros_mod.SorosPricedIn(
                priced_in=0.40, reason="replay stub priced-in"
            )
        else:
            parsed = soros_mod.SorosNarrative(
                narrative="replay 백테스트 통합 평가 stub narrative"
            )
        return (
            ClaudeResult(
                text="x",
                model="claude-test",
                input_tokens=10,
                output_tokens=10,
                cost_estimate_usd=0.0005,
            ),
            parsed,
        )

    monkeypatch.setattr(soros_mod, "call_claude", fake_call)

    # Soros.fetch_m3 hits Supabase for recent_quotes + previous_signal.
    # Stub it so the test doesn't need a live DB connection.
    from agents.characters._data import KrQuoteRow
    from agents.weights.constants import DEFAULT_WEIGHTS

    def fake_fetch_m3(
        self: Any,
        ticker: str,
        voters: Any,
        *,
        user_id: Any = None,
    ) -> Any:
        weights = {
            agent: Decimal(str(getattr(DEFAULT_WEIGHTS, agent)))
            for agent in (
                "simons", "graham", "dow", "shiller", "keynes", "taleb"
            )
        }
        recent = [
            KrQuoteRow(
                date=Date(2026, 4, 9),
                ticker=ticker,
                open=60_000, high=60_500, low=59_500, close=60_000,
                volume=1_000_000, trading_value=60_000_000_000,
                foreign_net_buy=0, change_rate=0.0,
            )
            for _ in range(30)
        ]
        return soros_mod.SorosInputsM3(
            voters=voters, weights=weights,
            recent_quotes=recent, previous_signal=None,
        )

    monkeypatch.setattr(soros_mod.Soros, "fetch_m3", fake_fetch_m3)


def test_replay_writes_csv_and_resumes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_characters_and_soros(monkeypatch)

    out = tmp_path / "results.csv"
    state = replay_mod.run_replay(
        tickers=["005930", "000660"],
        dates=[Date(2026, 4, 9), Date(2026, 4, 16)],
        cost_budget_usd=15.0,
        out_path=out,
        soros_repo=MagicMock(),
    )

    assert state.rows_written == 4   # 2 tickers × 2 dates
    assert state.cap_hit is False
    assert out.exists()

    with out.open() as f:
        rows = list(csv.DictReader(f))
    assert len(rows) == 4
    # CSV schema columns are all present.
    for col in replay_mod.CSV_FIELDS:
        assert col in rows[0]
    # Voter scores all populated.
    for r in rows:
        assert r["graham_score"]
        assert r["taleb_severity"] == "2"
        assert r["final_grade"] in (
            "STRONG_BUY", "BUY", "HOLD", "CAUTION", "RISK"
        )

    # Resume: re-run, every row should be skipped.
    state2 = replay_mod.run_replay(
        tickers=["005930", "000660"],
        dates=[Date(2026, 4, 9), Date(2026, 4, 16)],
        cost_budget_usd=15.0,
        out_path=out,
        soros_repo=MagicMock(),
    )
    assert state2.rows_written == 0
    assert state2.skipped_existing == 4


def test_dry_run_repo_returns_none_for_previous_signal() -> None:
    """Regression: a bare MagicMock as Soros repo produces a MagicMock
    for ``latest_final_signal`` which then blows up Pydantic validation
    inside SignalChangeEventNew. The dry-run repo must return None."""
    repo = replay_mod._make_dry_run_repo()
    assert repo.latest_final_signal("005930") is None


def test_replay_cost_cap_halts_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _patch_characters_and_soros(monkeypatch)

    out = tmp_path / "capped.csv"
    # Each ticker costs ~ 5×0.001 (chars) + 2×0.0005 (soros) ≈ 0.006.
    # Cap at 0.011 → ticker 1 brings running to 0.006 (under), ticker 2
    # to 0.012 (over). The next-iteration check halts before ticker 3.
    state = replay_mod.run_replay(
        tickers=["005930", "000660", "035420"],
        dates=[Date(2026, 4, 9)],
        cost_budget_usd=0.011,
        out_path=out,
        soros_repo=MagicMock(),
    )
    assert state.cap_hit is True
    assert state.rows_written == 2
