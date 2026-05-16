"""Tests for signals.kr_fear_greed aggregation logic.

We test the pure aggregation step (`_aggregate_components`) and the
percentile-rank helper directly — the component-level functions hit
Supabase so they're exercised through the orchestrator's integration
suite, not here.
"""
from __future__ import annotations

import math

import pytest

from signals.kr_fear_greed import (
    NEUTRAL,
    KrFearGreedResult,
    _aggregate_components,
    _percentile_rank,
)


class TestPercentileRank:
    def test_value_below_all(self):
        assert _percentile_rank(0.0, [1.0, 2.0, 3.0]) == 0.0

    def test_value_above_all(self):
        assert _percentile_rank(99.0, [1.0, 2.0, 3.0]) == 100.0

    def test_value_in_middle(self):
        # 2 of 3 below, 0 equal → 2/3 * 100
        assert _percentile_rank(2.5, [1.0, 2.0, 3.0]) == pytest.approx(66.666, abs=0.01)

    def test_ties_resolved_to_midpoint(self):
        # value tied with 2 of 5 → (below=1 + 0.5*2) / 5 = 2/5 → 40
        result = _percentile_rank(2.0, [1.0, 2.0, 2.0, 3.0, 4.0])
        assert result == 40.0

    def test_empty_series_returns_neutral(self):
        assert _percentile_rank(1.0, []) == NEUTRAL


class TestAggregateComponents:
    def test_all_five_present_returns_mean(self):
        comps = {
            "kospi_momentum": 60.0,
            "volatility": 40.0,
            "breadth": 70.0,
            "foreign_flow": 50.0,
            "safe_haven": 30.0,
        }
        result = _aggregate_components(comps)
        assert isinstance(result, KrFearGreedResult)
        assert result.score == pytest.approx(50.0, abs=0.01)
        assert result.regime == "정상"

    def test_one_missing_excluded_from_mean(self):
        # mean of [60, 70, 50, 30] = 52.5; missing component skipped
        comps = {
            "kospi_momentum": 60.0,
            "volatility": None,
            "breadth": 70.0,
            "foreign_flow": 50.0,
            "safe_haven": 30.0,
        }
        result = _aggregate_components(comps)
        assert result.score == pytest.approx(52.5, abs=0.01)

    def test_three_missing_falls_back_to_neutral(self):
        comps = {
            "kospi_momentum": 90.0,
            "volatility": None,
            "breadth": None,
            "foreign_flow": None,
            "safe_haven": 10.0,
        }
        result = _aggregate_components(comps)
        # Only 2 valid components — below the 3-min threshold
        assert result.score == NEUTRAL
        assert result.regime == "정상"

    def test_all_missing_falls_back_to_neutral(self):
        comps = {k: None for k in (
            "kospi_momentum", "volatility", "breadth", "foreign_flow", "safe_haven"
        )}
        result = _aggregate_components(comps)
        assert result.score == NEUTRAL

    def test_extreme_fear_regime_label(self):
        comps = {
            "kospi_momentum": 5.0,
            "volatility": 8.0,
            "breadth": 10.0,
            "foreign_flow": 12.0,
            "safe_haven": 15.0,
        }
        result = _aggregate_components(comps)
        assert result.score < 20
        assert result.regime == "극단적 공포"

    def test_extreme_greed_regime_label(self):
        comps = {
            "kospi_momentum": 95.0,
            "volatility": 90.0,
            "breadth": 88.0,
            "foreign_flow": 92.0,
            "safe_haven": 85.0,
        }
        result = _aggregate_components(comps)
        assert result.score >= 80
        assert result.regime == "극단적 탐욕"

    def test_score_bounded_to_0_100(self):
        comps = {
            "kospi_momentum": 100.0,
            "volatility": 100.0,
            "breadth": 100.0,
            "foreign_flow": 100.0,
            "safe_haven": 100.0,
        }
        result = _aggregate_components(comps)
        assert 0.0 <= result.score <= 100.0
        assert math.isfinite(result.score)
