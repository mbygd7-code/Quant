"""apps.api.routes.admin — DB-backed admin endpoints."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from apps.api.index import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def fake_db(monkeypatch):
    sb = MagicMock()
    # Default empty result for any chain ending in .execute()
    empty = MagicMock()
    empty.data = []
    sb.table.return_value.select.return_value.eq.return_value.execute.return_value = empty
    sb.table.return_value.select.return_value.eq.return_value.not_.is_.return_value.execute.return_value = empty
    sb.table.return_value.select.return_value.gte.return_value.lte.return_value.order.return_value.limit.return_value.execute.return_value = empty
    monkeypatch.setattr("apps.api.routes.admin._sb", lambda: sb)
    return sb


class TestDataQualityEndpoint:
    def test_returns_zero_counts_for_empty_db(self, client, fake_db):
        response = client.get("/api/admin/data-quality?date=2026-05-04")
        assert response.status_code == 200
        body = response.json()
        assert body["date"] == "2026-05-04"
        assert body["collected"]["korea_market_rows"] == 0
        assert body["scored"]["sentiment_completion_pct"] == 0.0

    def test_invalid_date_returns_400(self, client):
        response = client.get("/api/admin/data-quality?date=not-a-date")
        assert response.status_code == 400


class TestCostEndpoint:
    def test_returns_zero_when_cache_empty(self, client, monkeypatch):
        from cognition.utils.cache import InMemoryCache
        monkeypatch.setattr("apps.api.routes.admin.make_cache",
                            lambda: InMemoryCache(), raising=False)
        # cost_report imports make_cache lazily inside the function — patch what
        # the lazy import resolves to:
        from cognition.utils import cache as cache_mod
        monkeypatch.setattr(cache_mod, "make_cache", lambda: InMemoryCache())
        response = client.get("/api/admin/cost?date=2026-05-04")
        assert response.status_code == 200
        body = response.json()
        assert body["sentiment_calls"] == 0
        assert body["estimated_usd"] == 0.0

    def test_includes_cap_value(self, client, monkeypatch):
        monkeypatch.setenv("LLM_DAILY_CAP", "300")
        response = client.get("/api/admin/cost?date=2026-05-04")
        assert response.status_code == 200
        assert response.json()["cap"] == 300


class TestNotificationsLogEndpoint:
    def test_returns_empty_list(self, client, fake_db):
        response = client.get("/api/admin/notifications?date=2026-05-04&days=7")
        assert response.status_code == 200
        body = response.json()
        assert body["date_range"]["from"] == "2026-04-27"
        assert body["date_range"]["to"] == "2026-05-04"
        assert body["rows"] == []

    def test_days_bounds(self, client):
        # days=0 violates Query(ge=1)
        response = client.get("/api/admin/notifications?days=0")
        assert response.status_code == 422


class TestBacktestStatusEndpoint:
    def test_404_when_not_found(self, client, monkeypatch):
        sb = MagicMock()
        sb.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value.data = []
        monkeypatch.setattr("db.supabase_client.get_admin_client", lambda: sb)
        response = client.get("/api/backtest/00000000-0000-0000-0000-000000000001/status")
        assert response.status_code == 404

    def test_returns_row_when_found(self, client, monkeypatch):
        sb = MagicMock()
        row = {
            "id": "abc-123", "status": "running", "progress": 42,
            "result_url": None, "error": None,
            "run_url": "https://github.com/x/y/actions/runs/123",
            "created_at": "2026-05-04T00:00:00", "started_at": None,
            "completed_at": None, "params": {},
        }
        sb.table.return_value.select.return_value.eq.return_value.limit.return_value.execute.return_value.data = [row]
        monkeypatch.setattr("db.supabase_client.get_admin_client", lambda: sb)
        response = client.get("/api/backtest/abc-123/status")
        assert response.status_code == 200
        assert response.json()["status"] == "running"
        assert response.json()["progress"] == 42
