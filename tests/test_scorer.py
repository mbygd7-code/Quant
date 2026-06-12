"""cognition.scorer — 7-factor weighted score and 5-bucket signal."""
from __future__ import annotations

from datetime import date as Date
from unittest.mock import MagicMock, patch

import pytest

from cognition.__schemas__.scoring import AIScore, Rationale, SubScores
from cognition.scorer import StockScorer, WeightConfig, sigmoid


def _all_neutral_subs() -> SubScores:
    return SubScores(
        global_market=0.5, sector=0.5, related_us_stock=0.5,
        news_sentiment=0.5, fundamental=0.5, volume_flow=0.5,
        risk_penalty=0.5,
    )


# ───────────────────────────────────────────────────────────
# Combination math (the high-stakes line — formula correctness)
# ───────────────────────────────────────────────────────────
class TestCombination:
    def test_all_neutral_yields_0_45(self):
        """All sub_scores incl. risk_penalty = 0.5 → final = 0.45.

            0.5 * (0.20+0.20+0.20+0.15+0.10+0.10) - 0.5 * 0.05
            = 0.5 * 0.95 - 0.025
            = 0.475 - 0.025
            = 0.45

        (PROMPTS.md states 0.475 — that figure assumes risk_penalty = 0,
        not 0.5. Our SubScores model treats 'no data' as 0.5 across the
        board for consistency, so the correct math is 0.45.)
        """
        scorer = StockScorer(weights=WeightConfig())
        result = scorer._combine(_all_neutral_subs())
        assert result == pytest.approx(0.45, abs=1e-9)

    def test_all_neutral_with_zero_risk_yields_0_475(self):
        """The PROMPTS.md figure: 'no risk' interpretation."""
        scorer = StockScorer(weights=WeightConfig())
        sub = SubScores(
            global_market=0.5, sector=0.5, related_us_stock=0.5,
            news_sentiment=0.5, fundamental=0.5, volume_flow=0.5,
            risk_penalty=0.0,
        )
        assert scorer._combine(sub) == pytest.approx(0.475, abs=1e-9)

    def test_all_max_yields_above_threshold_strong(self):
        scorer = StockScorer(weights=WeightConfig())
        sub = SubScores(
            global_market=1.0, sector=1.0, related_us_stock=1.0,
            news_sentiment=1.0, fundamental=1.0, volume_flow=1.0,
            # kr_fear_greed is CONTRARIAN — max bullishness is extreme
            # FEAR (0.0), which contributes its full weight via (1-sub).
            risk_penalty=0.0, kr_fear_greed=0.0, kr_trade=1.0,
        )
        # Nine weights sum to 1.0, but _combine SUBTRACTS the risk
        # penalty term — so the max attainable raw score is
        # 1.0 - risk_penalty_weight = 0.95.
        assert scorer._combine(sub) == pytest.approx(0.95, abs=1e-9)

    def test_clipped_to_unit_interval(self):
        scorer = StockScorer(weights=WeightConfig())
        # All zeros + max risk penalty pushes raw negative; must clip to 0.
        sub = SubScores(
            global_market=0.0, sector=0.0, related_us_stock=0.0,
            news_sentiment=0.0, fundamental=0.0, volume_flow=0.0,
            risk_penalty=1.0,
        )
        result = scorer._combine(sub)
        assert result == 0.0

    def test_signal_thresholds(self):
        scorer = StockScorer(weights=WeightConfig())
        assert scorer._to_signal(0.85) == "강한 관심"
        assert scorer._to_signal(0.70) == "관심"
        assert scorer._to_signal(0.55) == "관망"
        assert scorer._to_signal(0.40) == "주의"
        assert scorer._to_signal(0.20) == "위험"

    def test_signal_boundary_values(self):
        scorer = StockScorer(weights=WeightConfig())
        assert scorer._to_signal(0.80) == "강한 관심"     # inclusive
        assert scorer._to_signal(0.65) == "관심"
        assert scorer._to_signal(0.50) == "관망"
        assert scorer._to_signal(0.35) == "주의"
        assert scorer._to_signal(0.349999) == "위험"


# ───────────────────────────────────────────────────────────
# Determinism — same inputs → same output (cache + scorer determinism)
# ───────────────────────────────────────────────────────────
class TestDeterminism:
    def test_same_subs_yield_same_final(self):
        scorer = StockScorer(weights=WeightConfig())
        sub = SubScores(
            global_market=0.65, sector=0.60, related_us_stock=0.78,
            news_sentiment=0.55, fundamental=0.50, volume_flow=0.62,
            risk_penalty=0.30,
        )
        results = [scorer._combine(sub) for _ in range(10)]
        assert max(results) - min(results) < 0.001


# ───────────────────────────────────────────────────────────
# Stub rationale shape (Prompt 07 will replace strings, but structure stable)
# ───────────────────────────────────────────────────────────
class TestRationale:
    def test_rationale_has_3_evidence_2_risks(self):
        scorer = StockScorer(weights=WeightConfig())
        sub = SubScores(
            global_market=0.7, sector=0.65, related_us_stock=0.8,
            news_sentiment=0.55, fundamental=0.5, volume_flow=0.6,
            risk_penalty=0.4,
        )
        rationale = scorer._build_stub_rationale(sub)
        assert isinstance(rationale, Rationale)
        assert len(rationale.evidence) == 3
        assert len(rationale.risks) == 2
        assert rationale.sub_scores == sub


# ───────────────────────────────────────────────────────────
# Sub-score: news (avg sentiment from DB)
# ───────────────────────────────────────────────────────────
class TestNewsSubScore:
    def _scorer(self, mock_db):
        scorer = StockScorer(weights=WeightConfig())
        # Replace internal db lookups by patching get_admin_client.
        with patch("cognition.scorer.get_admin_client", return_value=mock_db):
            yield scorer

    def test_no_news_returns_neutral(self, monkeypatch):
        sb = MagicMock()
        sb.table().select().eq().contains().not_.is_().execute.return_value.data = []
        monkeypatch.setattr("cognition.scorer.get_admin_client", lambda: sb)
        scorer = StockScorer(weights=WeightConfig())
        assert scorer._news("005930", Date(2026, 5, 4)) == 0.5

    def test_average_of_sentiments(self, monkeypatch):
        sb = MagicMock()
        # Scorer now uses a 3-day window (.gte().lte()) instead of strict .eq()
        sb.table().select().gte().lte().contains().not_.is_().execute.return_value.data = [
            {"sentiment_score": 0.8}, {"sentiment_score": 0.6}, {"sentiment_score": 0.7},
        ]
        monkeypatch.setattr("cognition.scorer.get_admin_client", lambda: sb)
        scorer = StockScorer(weights=WeightConfig())
        score = scorer._news("005930", Date(2026, 5, 4))
        assert score == pytest.approx(0.7, abs=1e-9)


# ───────────────────────────────────────────────────────────
# AIScore schema — final shape that gets persisted
# ───────────────────────────────────────────────────────────
class TestAIScoreSchema:
    def test_valid(self):
        sub = _all_neutral_subs()
        score = AIScore(
            date=Date(2026, 5, 4), ticker="005930",
            final_score=0.475, signal="주의",
            sub_scores=sub,
            rationale=Rationale(
                evidence=["a", "b", "c"], risks=["x", "y"],
                sub_scores=sub,
            ),
        )
        assert score.signal == "주의"

    def test_invalid_signal_label_rejected(self):
        from pydantic import ValidationError
        sub = _all_neutral_subs()
        with pytest.raises(ValidationError):
            AIScore(
                date=Date(2026, 5, 4), ticker="005930",
                final_score=0.475, signal="bullish",
                sub_scores=sub,
                rationale=Rationale(evidence=["a", "b", "c"], risks=["x", "y"], sub_scores=sub),
            )


def test_sigmoid_zero_is_half():
    assert sigmoid(0) == pytest.approx(0.5)
