"""Cycle orchestrator tests — InsufficientData skip + error isolation +
dry-run mode + report shape.
"""
from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters.soros import SynthesisResult
from agents.cycle.run_m2_cycle import CycleReport, TickerOutcome, run_cycle
from agents.db.models import (
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
        weights_snapshot={},
        narrative="synth narrative",
        confidence=Decimal("0.30"),
        taleb_override=False,
    )
    change = (
        SignalChangeEventNew(
            ticker="005930",
            from_grade=None,
            to_grade=grade,  # type: ignore[arg-type]
            to_signal_id=uuid4(),  # placeholder; orchestrator overwrites
            reason="agent_consensus_shift",
            taleb_override=False,
        )
        if with_change
        else None
    )
    return SynthesisResult(
        final_signal=final, change_event=change, cost_estimate_usd=0.005
    )


# ─── happy path ─────────────────────────────────────────────────────


def test_dry_run_one_ticker(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dry-run skips DB writes; report still records the proposed
    grade + cost."""
    from agents.cycle import run_m2_cycle as cycle_mod

    monkeypatch.setattr(
        cycle_mod.Graham,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("graham", "1.5"),
    )
    monkeypatch.setattr(
        cycle_mod.Dow,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("dow", "1.0"),
    )
    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize",
        lambda self, **kwargs: _synth_result("BUY"),
    )

    repo = MagicMock()
    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930"],
        dry_run=True,
        repo=repo,
    )

    assert report.tickers_attempted == 1
    assert report.success == 1
    assert report.errors == 0
    # No DB writes in dry-run.
    repo.insert_agent_output.assert_not_called()
    repo.insert_final_signal.assert_not_called()
    repo.insert_signal_change.assert_not_called()
    assert report.outcomes[0].grade == "BUY"
    assert report.outcomes[0].cost_estimate_usd > 0


def test_real_run_persists_three_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Production path: agent_outputs × 2, final_signals × 1, change_event."""
    from agents.cycle import run_m2_cycle as cycle_mod

    monkeypatch.setattr(
        cycle_mod.Graham,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("graham", "1.5"),
    )
    monkeypatch.setattr(
        cycle_mod.Dow,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("dow", "1.0"),
    )
    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize",
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
    assert repo.insert_agent_output.call_count == 2
    repo.insert_final_signal.assert_called_once()
    repo.insert_signal_change.assert_called_once()
    # to_signal_id should match the final_signal returned by repo.
    inserted_change = repo.insert_signal_change.call_args.args[0]
    assert inserted_change.to_signal_id == final_signal_id


# ─── error isolation ────────────────────────────────────────────────


def test_insufficient_data_skips_without_aborting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One ticker raising InsufficientDataError doesn't kill the cycle."""
    from agents.cycle import run_m2_cycle as cycle_mod

    def fake_graham_analyze(
        self: Any, ticker: str, cycle_at: datetime
    ) -> AgentOutputNew:
        if ticker == "005930":
            raise InsufficientDataError(
                character="graham",
                ticker=ticker,
                reason="no kr_fundamentals row",
            )
        return _agent_output_new("graham", "0.7")

    monkeypatch.setattr(cycle_mod.Graham, "analyze", fake_graham_analyze)
    monkeypatch.setattr(
        cycle_mod.Dow,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("dow", "0.5"),
    )
    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize",
        lambda self, **kwargs: _synth_result("HOLD", with_change=False),
    )

    repo = MagicMock()
    repo.insert_agent_output.side_effect = lambda out: _agent_output(
        out.agent_name, str(out.score)
    )
    repo.insert_final_signal.return_value = MagicMock(id=uuid4())

    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930", "000660"],
        repo=repo,
    )

    assert report.tickers_attempted == 2
    assert report.success == 1
    assert report.skipped == 1
    assert report.errors == 0
    skipped = next(o for o in report.outcomes if o.status == "skipped")
    assert skipped.ticker == "005930"
    assert "kr_fundamentals" in skipped.error


def test_unexpected_exception_isolates_to_one_ticker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unexpected exception in one ticker is captured in the report
    but doesn't abort the cycle."""
    from agents.cycle import run_m2_cycle as cycle_mod

    def fake_dow_analyze(
        self: Any, ticker: str, cycle_at: datetime
    ) -> AgentOutputNew:
        if ticker == "005930":
            raise RuntimeError("supabase 503")
        return _agent_output_new("dow", "0.4")

    monkeypatch.setattr(
        cycle_mod.Graham,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("graham", "0.5"),
    )
    monkeypatch.setattr(cycle_mod.Dow, "analyze", fake_dow_analyze)
    monkeypatch.setattr(
        cycle_mod.Soros,
        "synthesize",
        lambda self, **kwargs: _synth_result("HOLD", with_change=False),
    )

    repo = MagicMock()
    repo.insert_agent_output.side_effect = lambda out: _agent_output(
        out.agent_name, str(out.score)
    )
    repo.insert_final_signal.return_value = MagicMock(id=uuid4())

    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930", "000660"],
        repo=repo,
    )

    assert report.tickers_attempted == 2
    assert report.success == 1
    assert report.errors == 1
    assert report.skipped == 0
    errored = next(o for o in report.outcomes if o.status == "error")
    assert "503" in errored.error


# ─── report ────────────────────────────────────────────────────────


def test_report_summary_renders_grade_distribution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agents.cycle import run_m2_cycle as cycle_mod

    monkeypatch.setattr(
        cycle_mod.Graham,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("graham", "1.5"),
    )
    monkeypatch.setattr(
        cycle_mod.Dow,
        "analyze",
        lambda self, ticker, cycle_at: _agent_output_new("dow", "1.5"),
    )

    grades_iter = iter(["BUY", "STRONG_BUY", "HOLD", "BUY"])

    def fake_synth(self: Any, **kwargs: Any) -> SynthesisResult:
        return _synth_result(next(grades_iter), with_change=False)

    monkeypatch.setattr(cycle_mod.Soros, "synthesize", fake_synth)

    repo = MagicMock()
    repo.insert_agent_output.side_effect = lambda out: _agent_output(
        out.agent_name, str(out.score)
    )
    repo.insert_final_signal.return_value = MagicMock(id=uuid4())

    report = run_cycle(
        cycle_at=CYCLE_AT,
        tickers=["005930", "000660", "000270", "000020"],
        repo=repo,
    )

    text = report.summary()
    assert "BUY=2" in text
    assert "STRONG_BUY=1" in text
    assert "HOLD=1" in text


def test_empty_watchlist_returns_empty_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repo = MagicMock()
    # Stub the watchlist fetch — return empty list.
    repo.sb.table.return_value.select.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[]
    )

    report = run_cycle(cycle_at=CYCLE_AT, repo=repo)
    assert report.tickers_attempted == 0
    assert isinstance(report, CycleReport)


# Suppress unused-import nags
_ = TickerOutcome
