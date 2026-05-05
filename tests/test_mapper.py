"""cognition.mapper — sigmoid weighted score from US → KR mapping."""
from __future__ import annotations

from datetime import date as Date

import pytest

from cognition.mapper import (
    NEUTRAL_SCORE,
    WEIGHTED_CHANGE_SCALE,
    calculate_related_us_score,
    sigmoid,
)


class TestSigmoid:
    def test_zero_is_half(self):
        assert sigmoid(0.0) == pytest.approx(0.5)

    def test_positive_is_above_half(self):
        assert sigmoid(1.0) > 0.5

    def test_negative_is_below_half(self):
        assert sigmoid(-1.0) < 0.5

    def test_extreme_saturates(self):
        assert sigmoid(10.0) == pytest.approx(1.0, abs=1e-3)
        assert sigmoid(-10.0) == pytest.approx(0.0, abs=1e-3)


class TestCalculateRelatedUsScore:
    def _mappings(self):
        # Same fixtures used across tests so expectations stay consistent.
        return [
            {"us_symbol": "NVDA", "impact_strength": 0.92},
            {"us_symbol": "AMD",  "impact_strength": 0.80},
        ]

    def test_no_mappings_returns_neutral(self):
        score = calculate_related_us_score(
            "999999", Date(2026, 5, 4), mappings=[], us_changes={},
        )
        assert score == NEUTRAL_SCORE

    def test_no_us_data_returns_neutral(self):
        score = calculate_related_us_score(
            "000660", Date(2026, 5, 4),
            mappings=self._mappings(),
            us_changes={},                    # no change data for any symbol
        )
        assert score == NEUTRAL_SCORE

    def test_positive_us_moves_yield_score_above_half(self):
        score = calculate_related_us_score(
            "000660", Date(2026, 5, 4),
            mappings=self._mappings(),
            us_changes={"NVDA": 0.03, "AMD": 0.02},   # +3%, +2%
        )
        # Weighted ≈ (0.03*0.92 + 0.02*0.80) / (0.92 + 0.80) ≈ 0.0254
        # σ(0.0254 * 50) ≈ σ(1.27) ≈ 0.78
        assert score > 0.7

    def test_negative_us_moves_yield_score_below_half(self):
        score = calculate_related_us_score(
            "000660", Date(2026, 5, 4),
            mappings=self._mappings(),
            us_changes={"NVDA": -0.03, "AMD": -0.02},
        )
        assert score < 0.3

    def test_partial_data_uses_only_available(self):
        score = calculate_related_us_score(
            "000660", Date(2026, 5, 4),
            mappings=self._mappings(),
            us_changes={"NVDA": 0.05},        # AMD missing
        )
        # Only NVDA used → weighted = 0.05, σ(0.05 * 50) = σ(2.5) ≈ 0.92
        assert score > 0.85

    def test_neutral_us_moves_yield_neutral_score(self):
        score = calculate_related_us_score(
            "000660", Date(2026, 5, 4),
            mappings=self._mappings(),
            us_changes={"NVDA": 0.0, "AMD": 0.0},
        )
        assert score == pytest.approx(0.5, abs=0.01)

    def test_scale_constant_documented(self):
        """The scale value is part of the public contract — guard against
        accidental tuning that would invalidate downstream score thresholds."""
        assert WEIGHTED_CHANGE_SCALE == 50.0
