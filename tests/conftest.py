"""Shared pytest fixtures.

The collectors layer touches Supabase Storage and the pykrx/finnhub SDKs.
We mock all of those at the boundary so tests run offline and deterministic.
"""
from __future__ import annotations

from datetime import date as Date
from unittest.mock import MagicMock

import pytest


@pytest.fixture(autouse=True)
def _env_defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set safe defaults so collectors / db modules import cleanly."""
    monkeypatch.setenv("SUPABASE_URL", "https://test.supabase.co")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-key")
    monkeypatch.setenv("SUPABASE_ANON_KEY", "test-anon-key")
    monkeypatch.setenv("FINNHUB_API_KEY", "test-finnhub-key")
    monkeypatch.setenv("FINNHUB_REQ_INTERVAL", "0")          # don't sleep in tests
    monkeypatch.setenv("FINNHUB_CONCURRENCY", "8")
    monkeypatch.setenv("EXECUTION_MODE", "report_only")


@pytest.fixture
def mock_storage(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Stub `db.storage_client.upload_raw` so collectors don't hit Supabase."""
    mock = MagicMock(return_value="2026-05-05/test.json")
    monkeypatch.setattr("collectors._base.upload_raw", mock)
    return mock


@pytest.fixture
def krx_target_date() -> Date:
    return Date(2026, 5, 4)         # a Monday — `prev_kr_business_day` returns prior Friday
