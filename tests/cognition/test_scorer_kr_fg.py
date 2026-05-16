"""Scorer tests covering the 8th weight (kr_fear_greed)."""
from __future__ import annotations

import pytest

from cognition.scorer import WeightConfig, StockScorer
from cognition.__schemas__.scoring import SubScores


class TestWeightConfigDefaults:
    def test_eight_weights_sum_to_one(self):
        w = WeightConfig()
        total = (
            w.global_market
            + w.sector
            + w.related_us_stock
            + w.news_sentiment
            + w.fundamental
            + w.volume_flow
            + w.risk_penalty
            + w.kr_fear_greed
        )
        assert total == pytest.approx(1.0, abs=0.001)

    def test_kr_fear_greed_default_is_five_percent(self):
        w = WeightConfig()
        assert w.kr_fear_greed == pytest.approx(0.05)


class TestCombineWithKrFG:
    def _scorer_with(self, weights: WeightConfig) -> StockScorer:
        # Bypass _load_active_weights by constructing directly
        scorer = StockScorer(weights=weights)
        return scorer

    def _make_subscores(self, **overrides) -> SubScores:
        defaults = {
            "global_market": 0.5,
            "sector": 0.5,
            "related_us_stock": 0.5,
            "news_sentiment": 0.5,
            "fundamental": 0.5,
            "volume_flow": 0.5,
            "risk_penalty": 0.0,  # so the negative term doesn't muddy the math
            "kr_fear_greed": 0.5,
        }
        defaults.update(overrides)
        return SubScores(**defaults)

    def test_kr_fg_contributes_proportional_to_weight(self):
        """Doubling kr_fear_greed weight ~doubles its delta contribution."""
        light_w = WeightConfig(
            global_market=0.20, sector=0.20, related_us_stock=0.19,
            news_sentiment=0.14, fundamental=0.10, volume_flow=0.10,
            risk_penalty=0.05, kr_fear_greed=0.02,
        )
        # Normalize the rest so the heavy variant still sums to 1.0
        heavy_w = WeightConfig(
            global_market=0.19, sector=0.19, related_us_stock=0.17,
            news_sentiment=0.12, fundamental=0.10, volume_flow=0.09,
            risk_penalty=0.04, kr_fear_greed=0.10,
        )

        sub_neutral = self._make_subscores(kr_fear_greed=0.5)
        sub_extreme = self._make_subscores(kr_fear_greed=1.0)

        light_scorer = self._scorer_with(light_w)
        heavy_scorer = self._scorer_with(heavy_w)

        light_delta = (
            light_scorer._combine(sub_extreme) - light_scorer._combine(sub_neutral)
        )
        heavy_delta = (
            heavy_scorer._combine(sub_extreme) - heavy_scorer._combine(sub_neutral)
        )
        # Heavy weight (0.10) should produce ~5x the delta of light (0.02).
        # The 0.5 → 1.0 swing × weight = exact delta if other factors stay constant.
        assert heavy_delta == pytest.approx(0.10 * 0.5, abs=0.001)
        assert light_delta == pytest.approx(0.02 * 0.5, abs=0.001)
        assert heavy_delta > light_delta * 4.5

    def test_setting_kr_fg_weight_to_zero_makes_factor_inert(self):
        """Rollback property: kr_fear_greed_weight = 0 → 8th term vanishes."""
        w = WeightConfig(
            global_market=0.20, sector=0.20, related_us_stock=0.20,
            news_sentiment=0.15, fundamental=0.10, volume_flow=0.10,
            risk_penalty=0.05, kr_fear_greed=0.0,
        )
        scorer = self._scorer_with(w)
        sub_a = self._make_subscores(kr_fear_greed=0.0)
        sub_b = self._make_subscores(kr_fear_greed=1.0)
        assert scorer._combine(sub_a) == scorer._combine(sub_b)

    def test_combine_clamps_to_unit_interval(self):
        w = WeightConfig()
        scorer = self._scorer_with(w)
        # All-high inputs
        high = self._make_subscores(
            global_market=1.0, sector=1.0, related_us_stock=1.0,
            news_sentiment=1.0, fundamental=1.0, volume_flow=1.0,
            kr_fear_greed=1.0,
        )
        assert 0.0 <= scorer._combine(high) <= 1.0
        # All-low + max risk
        low = self._make_subscores(
            global_market=0.0, sector=0.0, related_us_stock=0.0,
            news_sentiment=0.0, fundamental=0.0, volume_flow=0.0,
            risk_penalty=1.0, kr_fear_greed=0.0,
        )
        assert 0.0 <= scorer._combine(low) <= 1.0


class TestSubScoresSchema:
    def test_kr_fear_greed_has_default_for_legacy_rows(self):
        """Old persisted SubScores without kr_fear_greed should still parse."""
        sub = SubScores(
            global_market=0.5,
            sector=0.5,
            related_us_stock=0.5,
            news_sentiment=0.5,
            fundamental=0.5,
            volume_flow=0.5,
            risk_penalty=0.0,
            # kr_fear_greed omitted on purpose
        )
        assert sub.kr_fear_greed == 0.5  # default neutral

    def test_kr_fear_greed_rejects_out_of_range(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            SubScores(
                global_market=0.5, sector=0.5, related_us_stock=0.5,
                news_sentiment=0.5, fundamental=0.5, volume_flow=0.5,
                risk_penalty=0.0, kr_fear_greed=1.5,
            )
