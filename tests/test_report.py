"""signals.report — schema, forbidden-word validation, retry, disclaimer, preview."""
from __future__ import annotations

import asyncio
from datetime import date as Date
from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from cognition.utils.cache import InMemoryCache
from signals.__schemas__.report import (
    DISCLAIMER,
    FORBIDDEN_WORDS,
    ForbiddenWordError,
    ReportSkipped,
    StockReport,
    validate_report,
    with_disclaimer,
)
from signals.preview_report import build_preview_markdown
from signals.report import ReportGenerator


# ───────────────────────────────────────────────────────────
# Schema constraints
# ───────────────────────────────────────────────────────────
class TestStockReportSchema:
    def _valid(self):
        return StockReport(
            positive_factors=["A", "B", "C"],
            risk_factors=["X", "Y"],
            comment="긍정 요인 우세, 변동성 주의 권장합니다.",
        )

    def test_valid(self):
        r = self._valid()
        assert len(r.positive_factors) == 3
        assert len(r.risk_factors) == 2

    def test_too_few_positive_factors_rejected(self):
        with pytest.raises(ValidationError):
            StockReport(
                positive_factors=["A", "B"],          # only 2
                risk_factors=["X", "Y"],
                comment="comment must be at least twenty chars long here.",
            )

    def test_too_many_positive_factors_rejected(self):
        with pytest.raises(ValidationError):
            StockReport(
                positive_factors=["A", "B", "C", "D"],
                risk_factors=["X", "Y"],
                comment="comment must be at least twenty chars long here.",
            )

    def test_short_comment_rejected(self):
        with pytest.raises(ValidationError):
            StockReport(
                positive_factors=["A", "B", "C"],
                risk_factors=["X", "Y"],
                comment="too short",                  # < 20 chars
            )


# ───────────────────────────────────────────────────────────
# Forbidden-word validation (CLAUDE.md section 3-A)
# ───────────────────────────────────────────────────────────
class TestForbiddenWords:
    def _report_with(self, text: str) -> StockReport:
        return StockReport(
            positive_factors=[text, "긍정 요인 두 번째 항목입니다.", "긍정 요인 세 번째 항목입니다."],
            risk_factors=["리스크 첫 번째 항목입니다.", "리스크 두 번째 항목입니다."],
            comment="전체 코멘트는 객관적 정보 정리에 그칩니다.",
        )

    @pytest.mark.parametrize("bad_word", FORBIDDEN_WORDS)
    def test_each_forbidden_word_caught(self, bad_word):
        bad = self._report_with(f"강한 모멘텀 — {bad_word} 권장")
        with pytest.raises(ForbiddenWordError, match=bad_word):
            validate_report(bad)

    def test_clean_report_passes(self):
        clean = self._report_with("긍정 요인 우세, 변동성 주의 권장")
        validate_report(clean)            # no exception

    def test_forbidden_word_in_comment_caught(self):
        report = StockReport(
            positive_factors=["A 항목", "B 항목", "C 항목"],
            risk_factors=["X 리스크", "Y 리스크"],
            comment="강한 관심 — 매수 적극 권장합니다.",       # contains 매수
        )
        with pytest.raises(ForbiddenWordError):
            validate_report(report)


# ───────────────────────────────────────────────────────────
# Disclaimer
# ───────────────────────────────────────────────────────────
class TestDisclaimer:
    def test_appended_when_missing(self):
        r = StockReport(
            positive_factors=["A 항목 첫번째", "B 항목 두번째", "C 항목 세번째"],
            risk_factors=["X 리스크 첫번째", "Y 리스크 두번째"],
            comment="객관적이고 충분히 긴 종합 코멘트 문장입니다.",
        )
        with_d = with_disclaimer(r)
        assert with_d.comment.endswith(DISCLAIMER.strip())

    def test_not_double_appended(self):
        r = StockReport(
            positive_factors=["A 항목 첫번째", "B 항목 두번째", "C 항목 세번째"],
            risk_factors=["X 리스크 첫번째", "Y 리스크 두번째"],
            comment=f"객관적이고 충분히 긴 종합 코멘트 문장입니다.{DISCLAIMER}",
        )
        with_d = with_disclaimer(r)
        assert with_d.comment.count("매매 권유가 아닙니다") == 1


# ───────────────────────────────────────────────────────────
# ReportGenerator — retry on forbidden words, then skip
# ───────────────────────────────────────────────────────────
def _fake_response(payload: dict):
    block = MagicMock()
    block.type = "tool_use"
    block.name = "record_report"
    block.input = payload
    response = MagicMock()
    response.content = [block]
    return response


def _good_payload() -> dict:
    return {
        "positive_factors": [
            "글로벌 사이클 우호적입니다 — 첫 번째 근거.",
            "관련 미국 종목 동조 강세 — 두 번째 근거.",
            "수급 점수 우호 — 세 번째 근거.",
        ],
        "risk_factors": [
            "단기 과열 가능성 — 첫 번째 리스크.",
            "환율 변동성 — 두 번째 리스크.",
        ],
        "comment": "긍정 요인 우세하나 변동성 확인 후 접근 권장 구간입니다.",
    }


def _bad_payload() -> dict:
    p = _good_payload()
    p["comment"] = "오늘 무조건 오른다 — 매수 강력 추천!"      # 3 forbidden words
    return p


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("LLM_DAILY_CAP", "100")
    return monkeypatch


def _make_generator(client) -> ReportGenerator:
    return ReportGenerator(
        anthropic_client=client,
        embedder=MagicMock(),
        cache=InMemoryCache(),
        model="claude-test",
    )


class TestReportGeneratorRetry:
    def test_clean_response_succeeds(self, env):
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=_fake_response(_good_payload()))
        gen = _make_generator(client)

        async def run():
            return await gen.generate_one(
                on_date=Date(2026, 5, 4), ticker="000660", name="SK하이닉스",
                sector="반도체", signal="강한 관심", final_score=0.82,
                sub_scores={}, news_top3=[], rag_top3=[],
            )

        result = asyncio.run(run())
        assert result.comment.endswith(DISCLAIMER.strip())
        assert client.messages.create.call_count == 1

    def test_forbidden_first_then_clean_retries(self, env):
        client = MagicMock()
        client.messages.create = AsyncMock(side_effect=[
            _fake_response(_bad_payload()),       # rejected
            _fake_response(_good_payload()),      # passes
        ])
        gen = _make_generator(client)

        async def run():
            return await gen.generate_one(
                on_date=Date(2026, 5, 4), ticker="000660", name="SK하이닉스",
                sector="반도체", signal="강한 관심", final_score=0.82,
                sub_scores={}, news_top3=[], rag_top3=[],
            )

        result = asyncio.run(run())
        assert result.comment.endswith(DISCLAIMER.strip())
        assert client.messages.create.call_count == 2

    def test_three_forbidden_responses_skip(self, env):
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=_fake_response(_bad_payload()))
        gen = _make_generator(client)

        async def run():
            await gen.generate_one(
                on_date=Date(2026, 5, 4), ticker="000660", name="SK하이닉스",
                sector="반도체", signal="강한 관심", final_score=0.82,
                sub_scores={}, news_top3=[], rag_top3=[],
            )

        with pytest.raises(ReportSkipped):
            asyncio.run(run())
        # 1 initial + 2 retries = 3 calls
        assert client.messages.create.call_count == 3

    def test_cache_hit_skips_api(self, env):
        client = MagicMock()
        client.messages.create = AsyncMock(return_value=_fake_response(_good_payload()))
        gen = _make_generator(client)

        async def run():
            args = dict(on_date=Date(2026, 5, 4), ticker="000660", name="SK하이닉스",
                        sector="반도체", signal="강한 관심", final_score=0.82,
                        sub_scores={}, news_top3=[], rag_top3=[])
            r1 = await gen.generate_one(**args)
            r2 = await gen.generate_one(**args)
            return r1, r2

        r1, r2 = asyncio.run(run())
        assert r1.comment == r2.comment
        assert client.messages.create.call_count == 1


# ───────────────────────────────────────────────────────────
# Preview report aggregator
# ───────────────────────────────────────────────────────────
class TestPreviewMarkdown:
    def test_renders_sections_and_top_picks(self, monkeypatch):
        sb = MagicMock()
        scores = [
            {"ticker": "000660", "signal": "강한 관심", "final_score": 0.82,
             "stocks": {"name": "SK하이닉스", "sector": "반도체"}},
            {"ticker": "005380", "signal": "관망", "final_score": 0.56,
             "stocks": {"name": "현대차", "sector": "자동차"}},
            {"ticker": "373220", "signal": "위험", "final_score": 0.28,
             "stocks": {"name": "LG에너지솔루션", "sector": "2차전지"}},
        ]
        market = [
            {"symbol": "^IXIC", "close": 18000.5, "change_rate": 0.018},
            {"symbol": "^SOX",  "close": 5500.0, "change_rate": 0.021},
            {"symbol": "^VIX",  "close": 14.2,   "change_rate": -0.03},
        ]
        sb.table.return_value.select.return_value.eq.return_value.execute.return_value.data = scores
        sb.table.return_value.select.return_value.eq.return_value.in_.return_value.execute.return_value.data = market
        monkeypatch.setattr("signals.preview_report.get_admin_client", lambda: sb)

        md = build_preview_markdown(Date(2026, 5, 4))
        assert "# 📊 2026-05-04 한국장 프리뷰" in md
        assert "글로벌 온도" in md
        assert "섹터 온도" in md
        assert "상위 5 종목" in md
        assert "SK하이닉스" in md
        assert "위험 신호" in md
        assert "투자 판단 보조 자료이며 매매 권유가 아닙니다" in md

    def test_empty_data_renders_safely(self, monkeypatch):
        sb = MagicMock()
        sb.table.return_value.select.return_value.eq.return_value.execute.return_value.data = []
        sb.table.return_value.select.return_value.eq.return_value.in_.return_value.execute.return_value.data = []
        monkeypatch.setattr("signals.preview_report.get_admin_client", lambda: sb)

        md = build_preview_markdown(Date(2026, 5, 4))
        assert "시장 데이터 없음" in md
        assert "섹터별 점수 없음" in md
