"""M3 cycle orchestrator tests — 4-voter dispatch + per-voter
isolation + Soros synthesis."""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters.soros import SynthesisResult
from agents.cycle.run_m3_cycle import M3_CHARACTER_ORDER, run_cycle
from agents.db.models import (
    AgentName,
    AgentOutput,
    AgentOutputNew,
    FinalSignalNew,
    SignalChangeEventNew,
)

CYCLE_AT = datetime(2026, 5, 9, 7, 0, tzinfo=UTC)


def _agent_output_new(agent: str, score: str = "1.0") -> AgentOutputNew:
    return AgentOutputNew(
        agent_name=agent,  # type: ignore[arg-type]
        cycle_at=CYCLE_AT,
        ticker="005930",
        score=Decimal(score),
        narrative="ok",
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
    )


def _agent_output(agent: str, score: str = "1.0") -> AgentOutput:
    return AgentOutput(
        id=uuid4(),
        agent_name=agent,  # type: ignore[arg-type]
        cycle_at=CYCLE_AT,
        ticker="005930",
        score=Decimal(score),
        severity=None,
        narrative="ok",
        raw_payload={},
        model="claude-test",
        cost_estimate=0.001,
        created_at=CYCLE_AT,
    )


def _synth_result(grade: str = "BUY", with_change: bool = True) -> SynthesisResult:
    final = FinalSignalNew(
        ticker="005930",
        cycle_at=CYCLE_AT,
        signal_grade=grade,  # type: ignore[arg-type]
        weighted_score=Decimal("0.50"),
        weights_snapshot={"voter_set": ["graham", "dow", "shiller", "keynes"]},
        narrative="m3 synth narrative",
        confidence=Decimal("0.30"),
        taleb_override=False,
    )
    change = (
        SignalChangeEventNew(
            ticker="005930",
            from_grade=None,
            to_grade=grade,  # type: ignore[arg-type]
            to_signal_id=uuid4(),
            reason="agent_consensus_shift",
            taleb_override=False,
        )
        if with_change
        else None
    )
    return SynthesisResult(
        final_signal=final, change_event=change, cost_estimate_usd=0.005
    )


def _patch_all_characters_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stub every character's analyze() to return a valid output row."""

    for agent_name, cls in M3_CHARACTER_ORDER:
        monkeypatch.setattr(
            cls,
            "analyze",
            lambda self, ticker, cycle_at, agent_name=agent_name: (
                _agent_output_new(agent_name, "1.0")
            ),
        )


# ─── happy path ─────────────────────────────────────────────────────


def test_dry_run_persists_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    from agents.cycle import run_m3_cycle as cycle_mod

    _patch_all_characters_ok(monkeypatch)
    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize_m3",
        lambda self, **kwargs: _synth_result("BUY", with_change=True),
    )

    repo = MagicMock()
    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930"],
        dry_run=True,
        repo=repo,
    )

    assert report.success == 1
    repo.insert_agent_output.assert_not_called()
    repo.insert_final_signal.assert_not_called()


def test_real_run_persists_four_voter_outputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agents.cycle import run_m3_cycle as cycle_mod

    _patch_all_characters_ok(monkeypatch)
    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize_m3",
        lambda self, **kwargs: _synth_result("BUY", with_change=True),
    )

    repo = MagicMock()
    repo.insert_agent_output.side_effect = lambda out: _agent_output(
        out.agent_name, str(out.score)
    )
    final_signal_id = uuid4()
    repo.insert_final_signal.return_value = MagicMock(id=final_signal_id)

    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930"],
        repo=repo,
    )

    assert report.success == 1
    # Four voters → four agent_outputs inserts.
    assert repo.insert_agent_output.call_count == 4
    repo.insert_final_signal.assert_called_once()
    repo.insert_signal_change.assert_called_once()
    inserted_change = repo.insert_signal_change.call_args.args[0]
    assert inserted_change.to_signal_id == final_signal_id


# ─── per-voter isolation ───────────────────────────────────────────


def test_three_voters_with_one_insufficient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If Keynes raises InsufficientDataError, the cycle should still
    complete with 3 voters and Soros' synthesize_m3 receives only the
    three present voters."""
    from agents.cycle import run_m3_cycle as cycle_mod

    def fake_keynes_analyze(
        self: Any, ticker: str, cycle_at: datetime
    ) -> AgentOutputNew:
        raise InsufficientDataError(
            character="keynes", ticker=ticker, reason="no kr_macro_betas"
        )

    for agent_name, cls in M3_CHARACTER_ORDER:
        if agent_name == "keynes":
            monkeypatch.setattr(cls, "analyze", fake_keynes_analyze)
        else:
            monkeypatch.setattr(
                cls,
                "analyze",
                lambda self, ticker, cycle_at, an=agent_name: (
                    _agent_output_new(an, "1.0")
                ),
            )

    captured_voters: dict[str, dict[AgentName, AgentOutput]] = {"v": {}}

    def fake_synth(self: Any, **kwargs: Any) -> SynthesisResult:
        captured_voters["v"] = kwargs["voters"]
        return _synth_result("HOLD", with_change=False)

    monkeypatch.setattr(cycle_mod.Soros, "synthesize_m3", fake_synth)

    repo = MagicMock()
    repo.insert_agent_output.side_effect = lambda out: _agent_output(
        out.agent_name, str(out.score)
    )
    repo.insert_final_signal.return_value = MagicMock(id=uuid4())

    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930"],
        repo=repo,
    )

    assert report.success == 1
    assert "keynes" not in captured_voters["v"]
    assert set(captured_voters["v"]) == {"graham", "dow", "shiller"}
    # voters_dropped reason captured in outcome
    outcome = report.outcomes[0]
    assert outcome.error is not None
    assert "keynes" in outcome.error


def test_all_voters_failing_marks_ticker_skipped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If every voter raises, the ticker is recorded as 'skipped'
    without invoking Soros."""
    from agents.cycle import run_m3_cycle as cycle_mod

    for _name, cls in M3_CHARACTER_ORDER:
        monkeypatch.setattr(
            cls,
            "analyze",
            lambda self, ticker, cycle_at: (_ for _ in ()).throw(
                InsufficientDataError(
                    character="x", ticker=ticker, reason="no data"
                )
            ),
        )

    soros_mock = MagicMock()
    monkeypatch.setattr(cycle_mod.Soros, "synthesize_m3", soros_mock)

    repo = MagicMock()
    report = run_cycle(
        cycle_at=CYCLE_AT, tickers=["005930"], repo=repo
    )

    assert report.skipped == 1
    soros_mock.assert_not_called()


def test_unexpected_voter_exception_is_isolated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-InsufficientData exception in one voter should drop that
    voter (treated like a skip from the other voters' perspective)
    rather than aborting the whole ticker."""
    from agents.cycle import run_m3_cycle as cycle_mod

    def fake_dow_analyze(
        self: Any, ticker: str, cycle_at: datetime
    ) -> AgentOutputNew:
        raise RuntimeError("supabase 503")

    for agent_name, cls in M3_CHARACTER_ORDER:
        if agent_name == "dow":
            monkeypatch.setattr(cls, "analyze", fake_dow_analyze)
        else:
            monkeypatch.setattr(
                cls,
                "analyze",
                lambda self, ticker, cycle_at, an=agent_name: (
                    _agent_output_new(an, "0.5")
                ),
            )

    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize_m3",
        lambda self, **kwargs: _synth_result("HOLD", with_change=False),
    )

    repo = MagicMock()
    repo.insert_agent_output.side_effect = lambda out: _agent_output(
        out.agent_name, str(out.score)
    )
    repo.insert_final_signal.return_value = MagicMock(id=uuid4())

    report = run_cycle(
        cycle_at=CYCLE_AT, tickers=["005930"], repo=repo
    )
    # Three voters wrote rows, ticker still succeeds.
    assert report.success == 1
    assert repo.insert_agent_output.call_count == 3
    outcome = report.outcomes[0]
    assert outcome.error is not None
    assert "dow" in outcome.error
    assert "503" in outcome.error
