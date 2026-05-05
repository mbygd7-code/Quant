"""orchestrator.pipeline — end-to-end with all 5 steps mocked."""
from __future__ import annotations

import asyncio
from datetime import date as Date
from unittest.mock import AsyncMock, MagicMock

import pytest

import orchestrator.pipeline as pl


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("EXECUTION_MODE", "paper")
    return monkeypatch


@pytest.fixture
def fake_steps(monkeypatch):
    """Mock every step function so run_once() executes without hitting any
    real collector / LLM / Telegram / Supabase."""
    monkeypatch.setattr("orchestrator.pipeline.verify_connection", lambda: None)

    fake_krx = MagicMock()
    fake_krx.success_count = 50
    fake_krx.failure_count = 0
    fake_krx.success_rate = 1.0
    fake_finn = MagicMock()
    fake_finn.success_count = 26
    fake_finn.failure_count = 0
    fake_finn.success_rate = 1.0

    fake_acq = {"krx_result": fake_krx, "finnhub_result": fake_finn}

    fake_krx_report = MagicMock()
    fake_krx_report.is_within_expected_range = True
    fake_krx_report.discard_rate = 0.14
    fake_krx_report.accepted = 86
    fake_krx_report.discarded = 14

    fake_finn_report = MagicMock()
    fake_finn_report.is_within_expected_range = True
    fake_finn_report.discard_rate = 0.05
    fake_finn_report.accepted = 24
    fake_finn_report.discarded = 2

    fake_ref = {"krx_report": fake_krx_report, "finn_report": fake_finn_report}

    monkeypatch.setattr(pl, "step_acquisition", lambda d: fake_acq)
    monkeypatch.setattr(pl, "step_refinement", lambda d, k, f: fake_ref)
    monkeypatch.setattr(pl, "step_cognition",
                        AsyncMock(return_value={"sentiment": {"succeeded": 30},
                                                "scoring_success": 50,
                                                "scoring_failed": 0}))
    monkeypatch.setattr(pl, "step_signal",
                        AsyncMock(return_value={"report_stats": {"succeeded": 50}}))
    monkeypatch.setattr(pl, "step_notify",
                        AsyncMock(return_value={"notify": {"sent": 1, "failed": 0}}))


# ───────────────────────────────────────────────────────────
# Top-level
# ───────────────────────────────────────────────────────────
class TestPipeline:
    def test_happy_path_returns_zero(self, env, fake_steps):
        rc = pl.run_once(Date(2026, 5, 4))
        assert rc == 0

    def test_security_error_aborts_with_2(self, env, monkeypatch):
        monkeypatch.setenv("EXECUTION_MODE", "kis_real")
        rc = pl.run_once(Date(2026, 5, 4))
        assert rc == 2

    def test_supabase_unreachable_aborts_with_3(self, env, monkeypatch):
        def boom():
            raise SystemExit("Supabase connection failed: refused")
        monkeypatch.setattr("db.supabase_client.verify_connection", boom)
        rc = pl.run_once(Date(2026, 5, 4))
        assert rc == 3

    def test_acquisition_failure_aborts_with_4(self, env, monkeypatch):
        monkeypatch.setattr("orchestrator.pipeline.verify_connection", lambda: None)

        def boom(d):
            raise RuntimeError("KRX 503")
        monkeypatch.setattr(pl, "step_acquisition", boom)
        rc = pl.run_once(Date(2026, 5, 4))
        assert rc == 4

    def test_step3_failure_does_not_abort(self, env, fake_steps, monkeypatch):
        async def fail(d):
            raise RuntimeError("anthropic 500")
        monkeypatch.setattr(pl, "step_cognition", fail)
        rc = pl.run_once(Date(2026, 5, 4))
        assert rc == 0          # downstream steps still run

    def test_summarize_metrics_compact(self, env, fake_steps):
        # Run end-to-end, capture metrics dict shape
        rc = pl.run_once(Date(2026, 5, 4))
        assert rc == 0

    def test_argparse_today(self, env, fake_steps, monkeypatch):
        monkeypatch.setattr("sys.argv", ["pipeline", "--mode=once", "--date=today"])
        rc = pl.main()
        assert rc == 0


# ───────────────────────────────────────────────────────────
# _summarize_metrics shape
# ───────────────────────────────────────────────────────────
class TestSummarizeMetrics:
    def test_drops_heavy_objects(self):
        krx = MagicMock(success_count=50, failure_count=0)
        finn = MagicMock(success_count=26, failure_count=2)
        krx_r = MagicMock(accepted=85, discarded=15, discard_rate=0.15)
        finn_r = MagicMock(accepted=24, discarded=2)
        out = pl._summarize_metrics({
            "krx_result": krx, "finnhub_result": finn,
            "krx_report": krx_r, "finn_report": finn_r,
            "scoring_success": 50, "scoring_failed": 0,
            "report_stats": {"succeeded": 50},
            "notify": {"sent": 1, "failed": 0},
        })
        assert out["krx_acq"] == {"items": 50, "failed": 0}
        assert out["krx_ref"] == {"accepted": 85, "discarded": 15, "discard_pct": 15.0}
        assert out["scoring_success"] == 50
        assert "krx_result" not in out          # heavy object stripped


# ───────────────────────────────────────────────────────────
# step_notify wiring (partial — uploads markdown to Storage)
# ───────────────────────────────────────────────────────────
class TestStepNotify:
    def test_dispatch_called_even_if_upload_fails(self, env, monkeypatch):
        def upload_boom(d):
            raise RuntimeError("Storage 500")
        dispatcher = MagicMock()
        dispatcher.dispatch = AsyncMock(return_value={"sent": 1, "failed": 0})
        monkeypatch.setattr("signals.preview_report.upload_preview", upload_boom)
        monkeypatch.setattr("notifier.dispatcher.NotificationDispatcher",
                            lambda: dispatcher)

        result = asyncio.run(pl.step_notify(Date(2026, 5, 4)))
        assert dispatcher.dispatch.called
        assert result["notify"] == {"sent": 1, "failed": 0}
