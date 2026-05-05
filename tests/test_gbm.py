"""signals.gbm — feature builder, GBM train/predict, prediction schema."""
from __future__ import annotations

from datetime import date as Date
from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError
from sklearn.datasets import make_classification

from signals.__schemas__.prediction import Prediction
from signals.features import FEATURE_NAMES, FeatureRow
from signals.gbm import GBMPredictor, InsufficientDataError


# ───────────────────────────────────────────────────────────
# Prediction schema
# ───────────────────────────────────────────────────────────
class TestPredictionSchema:
    def test_valid(self):
        p = Prediction(
            date=Date(2026, 5, 4), ticker="005930", prob_up=0.72,
            expected_volatility="medium", gap_risk="low",
            model_confidence=0.44, model_version="v1",
        )
        assert p.prob_up == 0.72

    def test_prob_out_of_range_rejected(self):
        with pytest.raises(ValidationError):
            Prediction(
                date=Date(2026, 5, 4), ticker="005930", prob_up=1.5,
                expected_volatility="medium", gap_risk="low",
                model_confidence=0.5, model_version="v1",
            )

    def test_unknown_volatility_label_rejected(self):
        with pytest.raises(ValidationError):
            Prediction(
                date=Date(2026, 5, 4), ticker="005930", prob_up=0.5,
                expected_volatility="extreme",          # not in 3-bucket enum
                gap_risk="low",
                model_confidence=0.0, model_version="v1",
            )


# ───────────────────────────────────────────────────────────
# FeatureBuilder + FeatureRow
# ───────────────────────────────────────────────────────────
class TestFeatureRow:
    def test_array_order_matches_feature_names(self):
        row = FeatureRow(ticker="005930", on_date=Date(2026, 5, 4))
        row.values = {name: float(i) for i, name in enumerate(FEATURE_NAMES)}
        arr = row.as_array()
        assert arr == [float(i) for i in range(len(FEATURE_NAMES))]

    def test_missing_keys_default_zero(self):
        row = FeatureRow(ticker="005930", on_date=Date(2026, 5, 4))
        # Only fill 2 of the 15 features.
        row.values = {"vix": 22.0, "kr_close_change": 0.012}
        arr = row.as_array()
        assert len(arr) == len(FEATURE_NAMES)
        assert arr[FEATURE_NAMES.index("vix")] == 22.0
        assert arr[FEATURE_NAMES.index("kr_close_change")] == 0.012
        # Others zero.
        assert arr[FEATURE_NAMES.index("us_nasdaq_change")] == 0.0


# ───────────────────────────────────────────────────────────
# GBM — synthetic data (no Supabase)
# ───────────────────────────────────────────────────────────
class TestGBMOnSyntheticData:
    """Bypass FeatureBuilder + DB by injecting synthetic X, y directly."""

    def test_predict_proba_sums_to_one(self):
        # Real sklearn check, no DB.
        X, y = make_classification(n_samples=300, n_features=15,
                                    n_informative=8, random_state=42)
        pred = GBMPredictor(model_version="test")
        pred._model = pred._build_model().fit(X, y)
        proba = pred._model.predict_proba(X[:1])
        assert pytest.approx(float(proba[0, 0] + proba[0, 1]), abs=1e-9) == 1.0

    def test_predict_raises_when_unfitted(self):
        pred = GBMPredictor(model_version="test")
        with pytest.raises(RuntimeError, match="before train"):
            pred.predict("005930", Date(2026, 5, 4))

    def test_train_raises_when_too_few_rows(self):
        sb = MagicMock()
        # Watchlist returns 1 ticker, but no closes → 0 training rows.
        sb.table().select().eq().execute().data = [{"ticker": "005930"}]
        sb.table().select().eq().gte().lte().order().execute().data = []
        pred = GBMPredictor(model_version="test", db=sb)
        with pytest.raises(InsufficientDataError, match=">= 200"):
            pred.train(Date(2026, 1, 1), Date(2026, 4, 30))


# ───────────────────────────────────────────────────────────
# Volatility / gap_risk labels
# ───────────────────────────────────────────────────────────
class TestRiskLabels:
    def _pred_with_db(self, korea_changes, mappings=None, gm_changes=None):
        sb = MagicMock()
        # Default empty result for any call
        empty = MagicMock()
        empty.data = []
        sb.table.return_value.select.return_value.eq.return_value.gte.return_value.lte.return_value.execute.return_value.data = (
            korea_changes
        )
        return GBMPredictor(db=sb), sb

    def test_volatility_high_when_avg_abs_change_above_2_5pct(self):
        pred, _sb = self._pred_with_db([
            {"change_rate": 0.04}, {"change_rate": -0.035}, {"change_rate": 0.03},
        ])
        label = pred._volatility_label("005930", Date(2026, 5, 4))
        assert label == "high"

    def test_volatility_low_when_avg_abs_change_below_1pct(self):
        pred, _sb = self._pred_with_db([
            {"change_rate": 0.005}, {"change_rate": -0.003}, {"change_rate": 0.007},
        ])
        label = pred._volatility_label("005930", Date(2026, 5, 4))
        assert label == "low"

    def test_volatility_medium_default_when_no_data(self):
        pred, _sb = self._pred_with_db([])
        label = pred._volatility_label("005930", Date(2026, 5, 4))
        assert label == "medium"
