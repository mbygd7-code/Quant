"""orchestrator.health_check — metric collection + markdown render + send."""
from __future__ import annotations

import asyncio
from datetime import date as Date
from unittest.mock import AsyncMock, MagicMock

import pytest

from orchestrator import health_check as hc


# ───────────────────────────────────────────────────────────
# render_message
# ───────────────────────────────────────────────────────────
class TestRender:
    def _daily(self):
        return {
            "date": "2026-05-04",
            "korea_market_rows": 50,
            "global_market_rows": 26,
            "news_total": 30,
            "news_scored": 28,
            "sentiment_completion_pct": 28 / 30,
            "scored_tickers": 50,
            "notif_sent": 1,
            "notif_failed": 0,
            "recent_failures": [],
        }

    def _cost(self):
        return {"model": "claude-sonnet-4-7", "calls_today": 78, "cap": 200,
                "usage_pct": 0.39, "estimated_usd": 2.34}

    def test_renders_basic_sections(self):
        text = hc.render_message(self._daily(), self._cost(), weekly=None)
        assert "Daily Health Check" in text
        assert "2026\\-05\\-04" in text
        assert "수집" in text
        assert "AI scores" in text
        assert "LLM 비용" in text
        assert "알림 발송" in text
        # No weekly section when None
        assert "주간 요약" not in text

    def test_friday_weekly_block_included(self):
        weekly = {
            "from": "2026-04-27",
            "to": "2026-05-04",
            "total_scores": 250,
            "avg_final_score": 0.58,
            "by_signal": {"강한 관심": 20, "관심": 60, "관망": 100, "주의": 50, "위험": 20},
        }
        text = hc.render_message(self._daily(), self._cost(), weekly=weekly)
        assert "주간 요약" in text
        assert "강한 관심" in text

    def test_failure_messages_listed(self):
        daily = self._daily()
        daily["notif_failed"] = 2
        daily["recent_failures"] = ["telegram 429 too many", "telegram 502 bad gateway"]
        text = hc.render_message(daily, self._cost(), weekly=None)
        assert "telegram 429 too many" in text
        assert "telegram 502 bad gateway" in text


# ───────────────────────────────────────────────────────────
# collect_daily_metrics — DB shape
# ───────────────────────────────────────────────────────────
class TestCollectDaily:
    def _make_sb(self, korea=0, global_=0, news_total=0, news_scored=0,
                 scored=0, notif=()):
        sb = MagicMock()
        # Build a deterministic mock that branches on table name.
        def table(name):
            t = MagicMock()
            if name == "korea_market":
                t.select.return_value.eq.return_value.execute.return_value.data = (
                    [{"ticker": f"{i:06d}"} for i in range(korea)]
                )
            elif name == "global_market":
                t.select.return_value.eq.return_value.execute.return_value.data = (
                    [{"symbol": f"S{i}"} for i in range(global_)]
                )
            elif name == "news_items":
                # Two distinct chains: full count + scored count
                full = MagicMock()
                full.eq.return_value.execute.return_value.data = (
                    [{"id": i} for i in range(news_total)]
                )
                full.eq.return_value.not_.is_.return_value.execute.return_value.data = (
                    [{"id": i} for i in range(news_scored)]
                )
                t.select.return_value = full
            elif name == "ai_scores":
                t.select.return_value.eq.return_value.execute.return_value.data = (
                    [{"ticker": f"{i:06d}"} for i in range(scored)]
                )
            elif name == "notifications":
                t.select.return_value.eq.return_value.execute.return_value.data = list(notif)
            return t
        sb.table.side_effect = table
        return sb

    def test_basic_counts(self, monkeypatch):
        sb = self._make_sb(korea=50, global_=26, news_total=30, news_scored=28,
                            scored=50, notif=[{"status": "sent"}])
        monkeypatch.setattr("db.supabase_client.get_admin_client", lambda: sb)
        m = hc.collect_daily_metrics(Date(2026, 5, 4))
        assert m["korea_market_rows"] == 50
        assert m["global_market_rows"] == 26
        assert m["news_total"] == 30
        assert m["news_scored"] == 28
        assert m["sentiment_completion_pct"] == pytest.approx(28 / 30)
        assert m["scored_tickers"] == 50
        assert m["notif_sent"] == 1
        assert m["notif_failed"] == 0

    def test_failure_messages_truncated(self, monkeypatch):
        long_err = "x" * 500
        sb = self._make_sb(notif=[
            {"status": "failed", "error": long_err},
            {"status": "failed", "error": "short err"},
            {"status": "sent"},
        ])
        monkeypatch.setattr("db.supabase_client.get_admin_client", lambda: sb)
        m = hc.collect_daily_metrics(Date(2026, 5, 4))
        assert m["notif_failed"] == 2
        assert len(m["recent_failures"]) == 2
        assert len(m["recent_failures"][0]) == 120          # truncated


# ───────────────────────────────────────────────────────────
# collect_cost_metrics — cache lookup
# ───────────────────────────────────────────────────────────
class TestCollectCost:
    def test_zero_when_cache_empty(self, monkeypatch):
        from cognition.utils.cache import InMemoryCache
        monkeypatch.setattr("cognition.utils.cache.make_cache", lambda: InMemoryCache())
        monkeypatch.setenv("ANTHROPIC_MODEL", "claude-test")
        monkeypatch.setenv("LLM_DAILY_CAP", "100")
        m = hc.collect_cost_metrics(Date(2026, 5, 4))
        assert m["calls_today"] == 0
        assert m["cap"] == 100
        assert m["usage_pct"] == 0.0
        assert m["estimated_usd"] == 0.0

    def test_with_cached_count(self, monkeypatch):
        from cognition.utils.cache import InMemoryCache
        cache = InMemoryCache()
        cache.set("llm:count:2026-05-04:claude-test", 75, ttl_seconds=3600)
        monkeypatch.setattr("cognition.utils.cache.make_cache", lambda: cache)
        monkeypatch.setenv("ANTHROPIC_MODEL", "claude-test")
        monkeypatch.setenv("LLM_DAILY_CAP", "200")
        m = hc.collect_cost_metrics(Date(2026, 5, 4))
        assert m["calls_today"] == 75
        assert m["usage_pct"] == 0.375
        assert m["estimated_usd"] == 75 * 0.030


# ───────────────────────────────────────────────────────────
# collect_weekly_metrics
# ───────────────────────────────────────────────────────────
class TestCollectWeekly:
    def test_aggregates_signals(self, monkeypatch):
        sb = MagicMock()
        rows = [
            {"date": "2026-05-01", "signal": "관심", "final_score": 0.7},
            {"date": "2026-05-02", "signal": "관심", "final_score": 0.66},
            {"date": "2026-05-03", "signal": "강한 관심", "final_score": 0.85},
            {"date": "2026-05-04", "signal": "주의", "final_score": 0.4},
        ]
        sb.table.return_value.select.return_value.gte.return_value.lte.return_value.execute.return_value.data = rows
        monkeypatch.setattr("db.supabase_client.get_admin_client", lambda: sb)
        m = hc.collect_weekly_metrics(Date(2026, 5, 4))
        assert m["total_scores"] == 4
        assert m["by_signal"]["관심"] == 2
        assert m["by_signal"]["강한 관심"] == 1
        assert m["avg_final_score"] == round((0.7 + 0.66 + 0.85 + 0.4) / 4, 3)


# ───────────────────────────────────────────────────────────
# send_health_check — graceful when env missing
# ───────────────────────────────────────────────────────────
class TestSend:
    def test_skip_when_token_missing(self, monkeypatch):
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        monkeypatch.delenv("TELEGRAM_ADMIN_CHAT_ID", raising=False)
        sent = asyncio.run(hc.send_health_check("hello"))
        assert sent is False

    def test_send_failure_returns_false(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-token")
        monkeypatch.setenv("TELEGRAM_ADMIN_CHAT_ID", "12345")
        notifier = MagicMock()
        notifier.send_admin_alert = AsyncMock(side_effect=RuntimeError("network down"))
        monkeypatch.setattr("notifier.telegram.TelegramNotifier", lambda **kw: notifier)
        sent = asyncio.run(hc.send_health_check("hello"))
        assert sent is False         # graceful — failures don't propagate

    def test_send_success_returns_true(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "test-token")
        monkeypatch.setenv("TELEGRAM_ADMIN_CHAT_ID", "12345")
        monkeypatch.setenv("DRY_RUN", "true")            # don't actually call Telegram
        notifier = MagicMock()
        notifier.send_admin_alert = AsyncMock(return_value=None)
        monkeypatch.setattr("notifier.telegram.TelegramNotifier", lambda **kw: notifier)
        sent = asyncio.run(hc.send_health_check("hello"))
        assert sent is True
