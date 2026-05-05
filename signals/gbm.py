"""GradientBoostingClassifier — predicts P(next-day return >= 1%).

Target rule (SKILL.md section 8):  y = 1 if next_day_close / today_close - 1 >= 0.01

Train flow:
  1. Pull historical (ticker, date) rows where we have features + a known
     next-day close.
  2. Build features via FeatureBuilder.
  3. Compute target from korea_market lookahead.
  4. TimeSeriesSplit(5) cross-validation, then refit on full history.
  5. Persist model to Supabase Storage (Phase 2 — for now keep in memory).

Predict flow:
  - build features for (ticker, on_date)
  - predict_proba → prob_up
  - confidence = |prob_up - 0.5| * 2

Insufficient data raises a clear error so the orchestrator skips this step
gracefully until enough history is collected.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date as Date
from datetime import timedelta

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import TimeSeriesSplit

from db.supabase_client import get_admin_client
from signals.__schemas__.prediction import Prediction
from signals.features import FEATURE_NAMES, FeatureBuilder

log = logging.getLogger("signals.gbm")

MIN_TRAINING_ROWS = 200
TARGET_RETURN_THRESHOLD = 0.01


class InsufficientDataError(RuntimeError):
    """Raised when there are not enough labeled rows to train the GBM."""


@dataclass
class TrainResult:
    rows: int
    cv_auc_mean: float
    feature_importances: dict[str, float]


class GBMPredictor:
    def __init__(self, model_version: str = "v1", db=None) -> None:
        self.model_version = model_version
        self._db = db or get_admin_client()
        self._builder = FeatureBuilder(db=self._db)
        self._model: GradientBoostingClassifier | None = None

    @property
    def is_fitted(self) -> bool:
        return self._model is not None

    # ──────────────────────────────────────────────────────
    # Train
    # ──────────────────────────────────────────────────────
    def train(self, start_date: Date, end_date: Date) -> TrainResult:
        X, y = self._build_training_set(start_date, end_date)
        if len(X) < MIN_TRAINING_ROWS:
            raise InsufficientDataError(
                f"Need >= {MIN_TRAINING_ROWS} labeled rows, got {len(X)}. "
                "Run the daily pipeline for several weeks first."
            )

        # CV evaluation
        tscv = TimeSeriesSplit(n_splits=5)
        aucs: list[float] = []
        for fold_idx, (train_idx, valid_idx) in enumerate(tscv.split(X)):
            fold_model = self._build_model()
            fold_model.fit(X[train_idx], y[train_idx])
            score = fold_model.score(X[valid_idx], y[valid_idx])
            aucs.append(float(score))
            log.info("GBM CV fold %d: accuracy=%.3f", fold_idx, score)

        # Refit on full history
        self._model = self._build_model()
        self._model.fit(X, y)
        importances = dict(zip(FEATURE_NAMES, self._model.feature_importances_, strict=True))
        return TrainResult(
            rows=len(X),
            cv_auc_mean=float(np.mean(aucs)),
            feature_importances={k: float(v) for k, v in importances.items()},
        )

    # ──────────────────────────────────────────────────────
    # Predict
    # ──────────────────────────────────────────────────────
    def predict(self, ticker: str, on_date: Date) -> Prediction:
        if not self.is_fitted:
            raise RuntimeError("GBMPredictor.predict() called before train()")
        row = self._builder.build(ticker, on_date)
        x = np.array([row.as_array()])
        proba = float(self._model.predict_proba(x)[0, 1])
        confidence = abs(proba - 0.5) * 2.0

        return Prediction(
            date=on_date,
            ticker=ticker,
            prob_up=proba,
            expected_volatility=self._volatility_label(ticker, on_date),
            gap_risk=self._gap_risk_label(ticker, on_date),
            model_confidence=confidence,
            model_version=self.model_version,
        )

    # ──────────────────────────────────────────────────────
    # Internals
    # ──────────────────────────────────────────────────────
    def _build_model(self) -> GradientBoostingClassifier:
        return GradientBoostingClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            random_state=42,
        )

    def _build_training_set(
        self, start_date: Date, end_date: Date,
    ) -> tuple[np.ndarray, np.ndarray]:
        sb = self._db
        # 1) Pull all watchlist tickers
        tickers = [
            r["ticker"] for r in (
                sb.table("stocks").select("ticker").eq("is_watchlist", True)
                  .execute().data or []
            )
        ]
        # 2) For each (ticker, date) in range, build features + lookahead target.
        X_rows: list[list[float]] = []
        y_rows: list[int] = []
        for ticker in tickers:
            closes = (
                sb.table("korea_market")
                  .select("date, close")
                  .eq("ticker", ticker)
                  .gte("date", start_date.isoformat())
                  .lte("date", (end_date + timedelta(days=5)).isoformat())
                  .order("date", desc=False)
                  .execute()
                  .data
            ) or []
            close_by_date: dict[str, float] = {r["date"]: float(r["close"]) for r in closes if r.get("close")}
            sorted_dates = sorted(close_by_date)
            for i, d in enumerate(sorted_dates[:-1]):
                if d > end_date.isoformat() or d < start_date.isoformat():
                    continue
                today_close = close_by_date[d]
                next_close = close_by_date[sorted_dates[i + 1]]
                if not today_close:
                    continue
                target = int((next_close / today_close - 1.0) >= TARGET_RETURN_THRESHOLD)
                features = self._builder.build(ticker, Date.fromisoformat(d))
                X_rows.append(features.as_array())
                y_rows.append(target)

        return np.array(X_rows, dtype=float), np.array(y_rows, dtype=int)

    def _volatility_label(self, ticker: str, on_date: Date) -> str:
        rows = (
            self._db.table("korea_market")
                .select("change_rate")
                .eq("ticker", ticker)
                .gte("date", (on_date - timedelta(days=14)).isoformat())
                .lte("date", on_date.isoformat())
                .execute()
                .data
        ) or []
        if not rows:
            return "medium"
        changes = [abs(float(r["change_rate"])) for r in rows
                   if r.get("change_rate") is not None]
        if not changes:
            return "medium"
        avg_abs = sum(changes) / len(changes)
        if avg_abs > 0.025:
            return "high"
        if avg_abs < 0.01:
            return "low"
        return "medium"

    def _gap_risk_label(self, ticker: str, on_date: Date) -> str:
        # Crude proxy: if related US move >2%, expect material gap.
        rows = (
            self._db.table("us_kr_mapping")
                .select("us_symbol, impact_strength")
                .eq("kr_ticker", ticker)
                .execute()
                .data
        ) or []
        if not rows:
            return "low"
        symbols = [r["us_symbol"] for r in rows]
        gm = (
            self._db.table("global_market")
                .select("symbol, change_rate")
                .eq("date", on_date.isoformat())
                .in_("symbol", symbols)
                .execute()
                .data
        ) or []
        idx = {r["symbol"]: float(r["change_rate"]) for r in gm
               if r.get("change_rate") is not None}
        weighted = sum(idx.get(r["us_symbol"], 0.0) * float(r["impact_strength"]) for r in rows)
        denom = sum(float(r["impact_strength"]) for r in rows)
        if not denom:
            return "low"
        avg = abs(weighted / denom)
        if avg > 0.025:
            return "high"
        if avg > 0.01:
            return "medium"
        return "low"
