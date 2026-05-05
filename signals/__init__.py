"""ML model, backtest, report generation.

Public surface:
  - GBMPredictor, Prediction        — Prompt 06 (this prompt)
  - InsufficientDataError           — train-time guard
  - FeatureBuilder, FEATURE_NAMES   — feature engineering
  - report, backtest                 — Prompts 07, 09 (later)
"""
from signals.__schemas__.prediction import Prediction
from signals.features import FEATURE_NAMES, FeatureBuilder, FeatureRow
from signals.gbm import GBMPredictor, InsufficientDataError, TrainResult

__all__ = [
    "GBMPredictor",
    "Prediction",
    "InsufficientDataError",
    "TrainResult",
    "FeatureBuilder",
    "FeatureRow",
    "FEATURE_NAMES",
]
