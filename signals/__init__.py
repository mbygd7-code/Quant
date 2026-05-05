"""ML model, backtest, report generation.

Public surface:
  - GBMPredictor, Prediction              — Prompt 06
  - InsufficientDataError                 — train-time guard
  - FeatureBuilder, FEATURE_NAMES         — feature engineering
  - StockReport, ReportGenerator          — Prompt 07
  - validate_report, ForbiddenWordError   — CLAUDE.md §3-A enforcement
  - generate_batch                        — daily report run
  - build_preview_markdown                — daily 50-stock summary
"""
from signals.__schemas__.prediction import Prediction
from signals.__schemas__.report import (
    DISCLAIMER,
    FORBIDDEN_WORDS,
    ForbiddenWordError,
    ReportSkipped,
    StockReport,
    validate_report,
    with_disclaimer,
)
from signals.features import FEATURE_NAMES, FeatureBuilder, FeatureRow
from signals.gbm import GBMPredictor, InsufficientDataError, TrainResult
from signals.preview_report import build_preview_markdown, upload_preview
from signals.report import ReportGenerator, generate_batch

__all__ = [
    # Prompt 06
    "GBMPredictor", "Prediction", "InsufficientDataError", "TrainResult",
    "FeatureBuilder", "FeatureRow", "FEATURE_NAMES",
    # Prompt 07
    "StockReport", "ReportGenerator", "generate_batch",
    "validate_report", "with_disclaimer",
    "ForbiddenWordError", "ReportSkipped",
    "FORBIDDEN_WORDS", "DISCLAIMER",
    "build_preview_markdown", "upload_preview",
]
