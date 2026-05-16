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
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import brier_score_loss, roc_auc_score
from sklearn.model_selection import GroupKFold, TimeSeriesSplit

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


@dataclass
class CalibratedTrainResult:
    """Result of the calibrated/group-aware training path.

    Adds Brier score (calibration goodness) on top of AUC, and a per-fold
    breakdown so we can spot regime shifts (training on a bull window then
    testing in a bear one).
    """
    rows: int
    n_groups: int          # distinct trading days used as folds
    auc_mean: float
    auc_std: float
    brier_mean: float
    brier_std: float
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
    # Calibrated training (Phase F per audit recommendation)
    # ──────────────────────────────────────────────────────
    def train_calibrated(
        self,
        start_date: Date,
        end_date: Date,
        *,
        n_splits: int = 5,
    ) -> CalibratedTrainResult:
        """Train with sigmoid calibration + group-aware K-fold by date.

        Addresses the audit's "cross-ticker information leak" finding —
        the legacy ``train()`` uses TimeSeriesSplit which lets the same
        trading day appear in both train and test folds via different
        tickers. ``GroupKFold(groups=date)`` prevents that.

        Sigmoid calibration on top of GBM tames over-confident probabilities,
        which matters because our downstream confidence indicator is
        ``|prob_up - 0.5| * 2`` — uncalibrated GBM often outputs 0.05/0.95
        even when the empirical hit rate is 30%/70%.
        """
        X, y, groups = self._build_training_set_with_groups(start_date, end_date)
        if len(X) < MIN_TRAINING_ROWS:
            raise InsufficientDataError(
                f"Need >= {MIN_TRAINING_ROWS} labeled rows, got {len(X)}. "
                "Run the daily pipeline for several weeks first."
            )
        n_groups = len(np.unique(groups))
        if n_groups < n_splits:
            raise InsufficientDataError(
                f"Need >= {n_splits} distinct trading days for GroupKFold, "
                f"got {n_groups}. Wait for more cron runs to accumulate."
            )

        gkf = GroupKFold(n_splits=n_splits)
        aucs: list[float] = []
        briers: list[float] = []
        for fold_idx, (train_idx, valid_idx) in enumerate(gkf.split(X, y, groups)):
            base = self._build_model()
            # Wrap with sigmoid calibration. cv='prefit' would skip the
            # internal CV but we want the cross-validated probabilities
            # for honest calibration, so cv=3 here. The outer GroupKFold
            # still prevents same-day leakage between train/valid.
            cal = CalibratedClassifierCV(base, method="sigmoid", cv=3)
            cal.fit(X[train_idx], y[train_idx])
            proba = cal.predict_proba(X[valid_idx])[:, 1]
            try:
                auc = roc_auc_score(y[valid_idx], proba)
            except ValueError:
                # Single-class fold (rare with binary target on tiny data).
                auc = 0.5
            brier = brier_score_loss(y[valid_idx], proba)
            aucs.append(float(auc))
            briers.append(float(brier))
            log.info(
                "GBM calibrated fold %d: AUC=%.3f, Brier=%.4f",
                fold_idx, auc, brier,
            )

        # Final fit on full history (calibrated) — used by predict().
        final = CalibratedClassifierCV(self._build_model(), method="sigmoid", cv=3)
        final.fit(X, y)
        self._model = final  # type: ignore[assignment]

        # Pull importances from the underlying classifier(s). Calibrated
        # wrapper exposes them via the first base_estimator_.
        try:
            base_est = final.calibrated_classifiers_[0].estimator
            importances = dict(
                zip(FEATURE_NAMES, base_est.feature_importances_, strict=True)
            )
        except (AttributeError, IndexError):
            importances = {name: 0.0 for name in FEATURE_NAMES}

        return CalibratedTrainResult(
            rows=len(X),
            n_groups=int(n_groups),
            auc_mean=float(np.mean(aucs)),
            auc_std=float(np.std(aucs)),
            brier_mean=float(np.mean(briers)),
            brier_std=float(np.std(briers)),
            feature_importances={k: float(v) for k, v in importances.items()},
        )

    def _build_training_set_with_groups(
        self, start_date: Date, end_date: Date,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Same as ``_build_training_set`` but also returns the date-keyed
        group label for GroupKFold. Re-uses the underlying builder so we
        don't fork the feature pipeline."""
        # Delegate to the existing path then re-derive groups from the
        # builder's iteration order. The legacy method is currently
        # date-major (outer loop = date) so reconstructing groups is
        # straightforward — but we re-implement here to keep the contract
        # explicit.
        sb = self._db
        tickers = [
            r["ticker"] for r in (
                sb.table("stocks").select("ticker").eq("is_watchlist", True)
                  .execute().data or []
            )
        ]
        rows_x: list[np.ndarray] = []
        rows_y: list[int] = []
        rows_g: list[int] = []  # group label = days since epoch
        epoch = Date(1970, 1, 1)

        cursor = start_date
        while cursor <= end_date:
            for ticker in tickers:
                try:
                    feat = self._builder.build(ticker, cursor)
                    label = self._target_label(ticker, cursor)
                    if label is None:
                        continue
                    rows_x.append(feat.as_array())
                    rows_y.append(int(label))
                    rows_g.append((cursor - epoch).days)
                except Exception:  # noqa: BLE001
                    continue
            cursor = cursor + timedelta(days=1)

        if not rows_x:
            return np.empty((0, len(FEATURE_NAMES))), np.empty(0), np.empty(0)
        return (
            np.vstack(rows_x),
            np.array(rows_y),
            np.array(rows_g),
        )

    def _target_label(self, ticker: str, on_date: Date) -> int | None:
        """Look up the next-trading-day close vs today; binary label."""
        sb = self._db
        rows = (
            sb.table("korea_market")
            .select("date, close")
            .eq("ticker", ticker)
            .gte("date", on_date.isoformat())
            .order("date", ascending=True)
            .limit(2)
            .execute()
            .data
            or []
        )
        if len(rows) < 2:
            return None
        today_close = rows[0].get("close")
        next_close = rows[1].get("close")
        if not today_close or not next_close or today_close == 0:
            return None
        ret = (next_close / today_close) - 1
        return 1 if ret >= TARGET_RETURN_THRESHOLD else 0

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
