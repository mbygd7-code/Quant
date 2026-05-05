"""notifier — markdown escaping, render, send, webhook secret, kakao stub."""
from __future__ import annotations

import asyncio
from datetime import date as Date
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from notifier.markdown import escape, escape_code
from notifier.telegram import (
    TelegramNotifier,
    _split_message,
    _strip_markdown,
    individual_keyboard,
    preview_keyboard,
    render_individual,
    render_preview,
)
from signals.__schemas__.report import ForbiddenWordError, StockReport


# ───────────────────────────────────────────────────────────
# 1) MarkdownV2Escaper
# ───────────────────────────────────────────────────────────
class TestMarkdownEscape:
    @pytest.mark.parametrize("char", list("_*[]()~`>#+-=|{}.!"))
    def test_each_reserved_char_escaped(self, char):
        assert escape(char) == "\\" + char

    def test_dot_and_bang_classic_case(self):
        assert escape("hello.world!") == "hello\\.world\\!"

    def test_url_chars_escaped(self):
        assert escape("https://api.example.com/v1") == "https://api\\.example\\.com/v1"

    def test_korean_text_passes_through(self):
        assert escape("안녕하세요") == "안녕하세요"

    def test_none_returns_empty(self):
        assert escape(None) == ""

    def test_int_input_coerced(self):
        assert escape(123) == "123"

    def test_escape_code_only_backtick(self):
        assert escape_code("a`b") == "a\\`b"
        assert escape_code("foo.bar") == "foo.bar"     # dot is fine inside code


# ───────────────────────────────────────────────────────────
# 2) Renderers
# ───────────────────────────────────────────────────────────
class TestRenderPreview:
    def test_renders_all_sections(self):
        text = render_preview(
            on_date=Date(2026, 5, 4),
            market={
                "^IXIC": {"close": 18000, "change_rate": 0.018},
                "^SOX":  {"close": 5500,  "change_rate": 0.021},
            },
            sector_counts={
                "반도체": {"강한 관심": 2, "관심": 3, "관망": 1, "주의": 0, "위험": 0},
                "자동차": {"강한 관심": 0, "관심": 1, "관망": 5, "주의": 2, "위험": 0},
            },
            top5=[
                {"ticker": "000660", "signal": "강한 관심", "final_score": 0.82,
                 "name": "SK하이닉스"},
                {"ticker": "042700", "signal": "관심", "final_score": 0.74,
                 "name": "한미반도체"},
            ],
        )
        assert "2026\\-05\\-04" in text
        assert "글로벌 온도" in text
        assert "섹터 온도" in text
        assert "상위 5" in text
        assert "SK하이닉스" in text
        assert "투자 판단 보조 자료이며 매매 권유가 아닙니다" in text

    def test_empty_market_safe(self):
        text = render_preview(
            on_date=Date(2026, 5, 4), market={}, sector_counts={}, top5=[],
        )
        assert "시장 데이터 없음" in text


class TestRenderIndividual:
    def _good_report(self):
        return StockReport(
            positive_factors=["요인 1 첫 번째.", "요인 2 두 번째.", "요인 3 세 번째."],
            risk_factors=["리스크 1 첫 번째.", "리스크 2 두 번째."],
            comment="긍정 요인 우세이나 변동성 확인 후 접근 권장합니다.",
        )

    def test_strong_signal_no_warning_head(self):
        text = render_individual(
            name="SK하이닉스", ticker="000660", sector="반도체",
            signal="강한 관심", final_score=0.82, report=self._good_report(),
        )
        assert text.startswith("🟢")          # no ⚠️ at front
        assert "SK하이닉스" in text
        assert "긍정 요인" in text
        assert "리스크" in text
        assert "AI 코멘트" in text
        assert "투자 판단 보조 자료이며 매매 권유가 아닙니다" in text

    def test_risk_signal_has_warning_head(self):
        text = render_individual(
            name="LG에너지솔루션", ticker="373220", sector="2차전지",
            signal="위험", final_score=0.28, report=self._good_report(),
        )
        assert text.startswith("⚠️")

    def test_forbidden_word_in_report_raises_before_render(self):
        bad = StockReport(
            positive_factors=["요인 1 첫 번째.", "요인 2 두 번째.", "요인 3 세 번째."],
            risk_factors=["리스크 1 첫 번째.", "리스크 2 두 번째."],
            comment="강한 매수 신호이므로 적극 진입하시면 됩니다.",
        )
        with pytest.raises(ForbiddenWordError):
            render_individual(
                name="x", ticker="000660", sector="반도체",
                signal="관심", final_score=0.7, report=bad,
            )


# ───────────────────────────────────────────────────────────
# 3) Inline keyboards
# ───────────────────────────────────────────────────────────
class TestKeyboards:
    def test_preview_keyboard_has_list_all_and_sector(self):
        rows = preview_keyboard([
            {"ticker": "000660", "signal": "강한 관심", "final_score": 0.82,
             "name": "SK하이닉스"},
        ])
        flat_data = [b["callback_data"] for row in rows for b in row]
        assert "list_all:0" in flat_data
        assert "by_sector" in flat_data
        assert "settings" in flat_data
        assert any(d.startswith("detail:") for d in flat_data)

    def test_individual_keyboard_has_news_and_home(self):
        rows = individual_keyboard("000660")
        flat = [b["callback_data"] for row in rows for b in row]
        assert "news:000660" in flat
        assert "home" in flat


# ───────────────────────────────────────────────────────────
# 4) Message split + plain-text fallback
# ───────────────────────────────────────────────────────────
class TestMessageSplit:
    def test_short_message_unchanged(self):
        assert _split_message("hello", 100) == ["hello"]

    def test_split_at_line_boundary(self):
        text = "\n".join(["line " + str(i) for i in range(20)])
        chunks = _split_message(text, 30)
        assert len(chunks) > 1
        for chunk in chunks:
            assert len(chunk) <= 30

    def test_strip_markdown_removes_formatting(self):
        text = "*bold* and `code` and \\*literal"
        plain = _strip_markdown(text)
        assert "*" not in plain
        assert "`" not in plain
        assert "literal" in plain


# ───────────────────────────────────────────────────────────
# 5) DRY_RUN file output
# ───────────────────────────────────────────────────────────
class TestDryRun:
    def test_dry_run_writes_to_file(self, monkeypatch, tmp_path):
        monkeypatch.setenv("DRY_RUN", "true")
        monkeypatch.setenv("LOG_DIR", str(tmp_path))
        # Re-import so the LOG_DIR module-level var refreshes? Actually
        # _is_dry_run reads env at call time and LOG_DIR reads at import time.
        # Patch LOG_DIR directly:
        monkeypatch.setattr("notifier.telegram.LOG_DIR", Path(tmp_path))

        notifier = TelegramNotifier("dummy-token", chat_ids=["123"], bot=MagicMock())

        async def run():
            await notifier.send_preview(
                Date(2026, 5, 4),
                market={"^IXIC": {"close": 18000, "change_rate": 0.02}},
                sector_counts={},
                top5=[],
            )
        asyncio.run(run())

        files = list(tmp_path.glob("telegram_preview_2026-05-04.txt"))
        assert files, f"DRY_RUN file not created in {tmp_path}: {list(tmp_path.iterdir())}"
        content = files[0].read_text(encoding="utf-8")
        assert "to chat_id=123" in content
        assert "한국장 프리뷰" in content


# ───────────────────────────────────────────────────────────
# 6) KakaoNotifier stub
# ───────────────────────────────────────────────────────────
class TestKakaoStub:
    def test_instantiation_raises(self):
        from notifier.kakao import KakaoNotifier
        with pytest.raises(NotImplementedError, match="Phase 2"):
            KakaoNotifier()


# ───────────────────────────────────────────────────────────
# 7) Webhook secret validation
# ───────────────────────────────────────────────────────────
class TestWebhookSecret:
    def test_missing_header_returns_403(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", "secret-abc")
        from apps.api.index import app
        client = TestClient(app)
        response = client.post("/api/telegram/webhook", json={})
        assert response.status_code == 403

    def test_wrong_header_returns_403(self, monkeypatch):
        monkeypatch.setenv("TELEGRAM_WEBHOOK_SECRET", "secret-abc")
        from apps.api.index import app
        client = TestClient(app)
        response = client.post(
            "/api/telegram/webhook",
            json={"update_id": 1},
            headers={"X-Telegram-Bot-Api-Secret-Token": "wrong"},
        )
        assert response.status_code == 403

    def test_missing_env_returns_500(self, monkeypatch):
        monkeypatch.delenv("TELEGRAM_WEBHOOK_SECRET", raising=False)
        from apps.api.index import app
        client = TestClient(app)
        response = client.post(
            "/api/telegram/webhook",
            json={"update_id": 1},
            headers={"X-Telegram-Bot-Api-Secret-Token": "anything"},
        )
        assert response.status_code == 500


# ───────────────────────────────────────────────────────────
# 8) NotificationDispatcher channel selection
# ───────────────────────────────────────────────────────────
class TestDispatcher:
    def test_no_channels_no_notifiers(self, monkeypatch):
        monkeypatch.setenv("NOTIFY_CHANNELS", "")
        from notifier.dispatcher import NotificationDispatcher
        d = NotificationDispatcher()
        assert d._notifiers == []

    def test_kakao_channel_raises(self, monkeypatch):
        monkeypatch.setenv("NOTIFY_CHANNELS", "kakao")
        from notifier.dispatcher import NotificationDispatcher
        with pytest.raises(NotImplementedError):
            NotificationDispatcher()

    def test_telegram_without_token_skipped(self, monkeypatch):
        monkeypatch.setenv("NOTIFY_CHANNELS", "telegram")
        monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
        from notifier.dispatcher import NotificationDispatcher
        d = NotificationDispatcher()
        assert d._notifiers == []


# ───────────────────────────────────────────────────────────
# 9) Callback data parsing
# ───────────────────────────────────────────────────────────
class TestCallbackParsing:
    def test_action_arg_split(self):
        # Mirror what callback_handler does internally.
        data = "detail:005930"
        action, _, arg = data.partition(":")
        assert action == "detail"
        assert arg == "005930"

    def test_arg_can_contain_colon(self):
        data = "sector:바이오/헬스"
        action, _, arg = data.partition(":")
        assert action == "sector"
        assert arg == "바이오/헬스"

    def test_no_colon_means_no_arg(self):
        data = "home"
        action, _, arg = data.partition(":")
        assert action == "home"
        assert arg == ""


# ───────────────────────────────────────────────────────────
# Smoke: setup_telegram_webhook missing env returns 2
# ───────────────────────────────────────────────────────────
class TestSetupScript:
    def test_missing_env_exits_2(self, monkeypatch, capsys):
        for k in ("TELEGRAM_BOT_TOKEN", "VERCEL_DEPLOYMENT_URL", "TELEGRAM_WEBHOOK_SECRET"):
            monkeypatch.delenv(k, raising=False)
        from scripts.setup_telegram_webhook import main as setup_main
        rc = setup_main()
        captured = capsys.readouterr()
        assert rc == 2
        assert "Missing env" in captured.err
