"""GBM regressor that predicts next-day final_score from sub-score features.

Companion to GBMPredictor (binary classifier in signals/gbm.py). This
regressor outputs three quantile estimates simultaneously (median +
95% prediction interval) so the web chart can show a confidence band.

Trains on (ai_scores at t, ai_scores at t+1) joined on ticker. Features
are the 7 sub-scores at t plus 3 momentum signals derived from
korea_market.

Recursive forecasting: to project H days ahead, we predict t+1, then
treat that prediction as the input "current score" for t+2, etc. The
exogenous features (US market, news) come from yesterday's data and
are reused — fine for short horizons (1-5 days).

Persistence: trained models are pickled to a local file but re-fit on
each run is cheap (~30-50 trees on <1k samples). For production we
re-train weekly via GitHub Actions.
"""
from __future__ import annotations

import logging
import pickle
from dataclasses import dataclass
from datetime import date as Date
from datetime import timedelta
from pathlib import Path
from typing import Any

import numpy as np

from db.supabase_client import get_admin_client

log = logging.getLogger("signals.score_regressor")

# Sub-score columns we use as features (7) + 3 derived momentum features = 10.
FEATURE_NAMES: list[str] = [
    "global_market_score",
    "sector_score",
    "related_us_stock_score",
    "news_sentiment_score",
    "fundamental_score",
    "volume_flow_score",
    "risk_penalty",
    "score_ema3",            # 3-day EMA of final_score
    "score_momentum_5",      # final_score(t) - final_score(t-5)
    "kr_change_3d",          # 3-day cumulative price change_rate
]

MODEL_VERSION = "gbr_r1"
DEFAULT_MIN_TRAIN_SAMPLES = 50


class InsufficientDataError(RuntimeError):
    pass


@dataclass
class ScorePrediction:
    date: Date
    ticker: str
    horizon_day: int
    target_date: Date
    predicted_score: float
    lower_95: float
    upper_95: float
    model_version: str


class ScoreRegressor:
    def __init__(self, model_version: str = MODEL_VERSION, db: Any = None) -> None:
        self.model_version = model_version
        self._db = db or get_admin_client()
        self._mid: Any = None
        self._lo: Any = None
        self._hi: Any = None

    @property
    def is_fitted(self) -> bool:
        return self._mid is not None

    # ──────────────────────────────────────────────────────
    # Train
    # ──────────────────────────────────────────────────────
    def train(self, start_date: Date, end_date: Date) -> dict[str, Any]:
        from sklearn.ensemble import GradientBoostingRegressor

        X, y = self._build_training_set(start_date, end_date)
        n = len(y)
        if n < DEFAULT_MIN_TRAIN_SAMPLES:
            raise InsufficientDataError(
                f"need ≥{DEFAULT_MIN_TRAIN_SAMPLES} samples, got {n}"
            )

        common = dict(
            n_estimators=120, max_depth=3, learning_rate=0.05,
            subsample=0.8, random_state=42,
        )
        self._mid = GradientBoostingRegressor(loss="quantile", alpha=0.5,   **common)
        self._lo  = GradientBoostingRegressor(loss="quantile", alpha=0.025, **common)
        self._hi  = GradientBoostingRegressor(loss="quantile", alpha=0.975, **common)
        self._mid.fit(X, y)
        self._lo.fit(X, y)
        self._hi.fit(X, y)

        # Self-check: residuals from median model
        y_hat = self._mid.predict(X)
        rmse = float(np.sqrt(np.mean((y - y_hat) ** 2)))
        return {
            "samples": n,
            "rmse_train": rmse,
            "feature_count": X.shape[1],
            "model_version": self.model_version,
        }

    def save(self, path: str | Path) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "wb") as f:
            pickle.dump({
                "version": self.model_version,
                "mid": self._mid, "lo": self._lo, "hi": self._hi,
            }, f)

    def load(self, path: str | Path) -> None:
        with open(path, "rb") as f:
            blob = pickle.load(f)
        self.model_version = blob["version"]
        self._mid = blob["mid"]
        self._lo = blob["lo"]
        self._hi = blob["hi"]

    # ──────────────────────────────────────────────────────
    # Predict
    # ──────────────────────────────────────────────────────
    def predict_horizon(
        self, ticker: str, on_date: Date, horizon_days: int = 5,
    ) -> list[ScorePrediction]:
        if not self.is_fitted:
            raise RuntimeError("ScoreRegressor.predict_horizon called before train")

        cur_features = self._build_feature_row(ticker, on_date)
        if cur_features is None:
            return []

        results: list[ScorePrediction] = []
        running_features = list(cur_features)
        cursor = on_date
        added = 0
        while added < horizon_days:
            cursor = cursor + timedelta(days=1)
            if cursor.weekday() >= 5:
                continue                                # skip weekend
            added += 1
            arr = np.array([running_features])
            mid = float(self._mid.predict(arr)[0])
            lo = float(self._lo.predict(arr)[0])
            hi = float(self._hi.predict(arr)[0])
            mid = max(0.0, min(1.0, mid))
            lo = max(0.0, min(1.0, lo))
            hi = max(0.0, min(1.0, hi))
            if lo > hi:
                lo, hi = hi, lo                         # quantile inversion safety
            results.append(ScorePrediction(
                date=on_date, ticker=ticker, horizon_day=added,
                target_date=cursor,
                predicted_score=mid, lower_95=lo, upper_95=hi,
                model_version=self.model_version,
            ))
            # Recursive: replace score-related features with today's prediction
            # so the next horizon step is conditioned on the path so far.
            running_features = self._roll_features(running_features, mid)
        return results

    # ──────────────────────────────────────────────────────
    # Feature building
    # ──────────────────────────────────────────────────────
    def _build_training_set(
        self, start_date: Date, end_date: Date,
    ) -> tuple[np.ndarray, np.ndarray]:
        sb = self._db
        watchlist = (
            sb.table("stocks").select("ticker")
              .eq("is_watchlist", True).execute().data
        ) or []
        tickers = [r["ticker"] for r in watchlist]

        # Pull all ai_scores within range + 1 day so we can form (t, t+1) pairs.
        rows = (
            sb.table("ai_scores")
              .select("date, ticker, global_market_score, sector_score, "
                      "related_us_stock_score, news_sentiment_score, "
                      "fundamental_score, volume_flow_score, risk_penalty, final_score")
              .gte("date", start_date.isoformat())
              .lte("date", (end_date + timedelta(days=2)).isoformat())
              .in_("ticker", tickers)
              .execute().data
        ) or []

        # Pull KR price data for kr_change_3d feature
        kr_rows = (
            sb.table("korea_market").select("date, ticker, change_rate")
              .gte("date", (start_date - timedelta(days=10)).isoformat())
              .lte("date", end_date.isoformat())
              .in_("ticker", tickers)
              .execute().data
        ) or []
        kr_by_ticker: dict[str, dict[str, float]] = {}
        for r in kr_rows:
            if r.get("change_rate") is None:
                continue
            kr_by_ticker.setdefault(r["ticker"], {})[r["date"]] = float(r["change_rate"])

        # Group ai_scores by ticker → sorted by date
        score_by_ticker: dict[str, list[dict]] = {}
        for r in rows:
            score_by_ticker.setdefault(r["ticker"], []).append(r)
        for t in score_by_ticker:
            score_by_ticker[t].sort(key=lambda x: x["date"])

        X_rows: list[list[float]] = []
        y_rows: list[float] = []
        for ticker, series in score_by_ticker.items():
            for i in range(len(series) - 1):
                today = series[i]
                tomorrow = series[i + 1]
                # next-day target only if dates are 1-3 business days apart
                d_today = Date.fromisoformat(today["date"])
                d_next = Date.fromisoformat(tomorrow["date"])
                if not (1 <= (d_next - d_today).days <= 4):
                    continue
                ema3 = self._compute_score_ema(series, i, 3)
                mom5 = self._compute_score_momentum(series, i, 5)
                kr_3d = self._compute_kr_change_3d(kr_by_ticker.get(ticker, {}), d_today)
                features = [
                    today.get("global_market_score") or 0.5,
                    today.get("sector_score") or 0.5,
                    today.get("related_us_stock_score") or 0.5,
                    today.get("news_sentiment_score") or 0.5,
                    today.get("fundamental_score") or 0.5,
                    today.get("volume_flow_score") or 0.5,
                    today.get("risk_penalty") or 0.5,
                    ema3, mom5, kr_3d,
                ]
                X_rows.append(features)
                y_rows.append(float(tomorrow["final_score"]))
        if not X_rows:
            raise InsufficientDataError("no (t, t+1) pairs found in range")
        return np.array(X_rows), np.array(y_rows)

    def _build_feature_row(self, ticker: str, on_date: Date) -> list[float] | None:
        sb = self._db
        # Latest ai_scores for ticker on or before on_date
        rows = (
            sb.table("ai_scores")
              .select("date, global_market_score, sector_score, "
                      "related_us_stock_score, news_sentiment_score, "
                      "fundamental_score, volume_flow_score, risk_penalty, final_score")
              .eq("ticker", ticker)
              .lte("date", on_date.isoformat())
              .order("date", desc=True)
              .limit(10)
              .execute().data
        ) or []
        if not rows:
            return None
        rows.sort(key=lambda r: r["date"])     # ascending
        latest = rows[-1]
        ema3 = self._compute_score_ema(rows, len(rows) - 1, 3)
        mom5 = self._compute_score_momentum(rows, len(rows) - 1, 5)

        # KR 3-day cumulative change
        kr_rows = (
            sb.table("korea_market").select("date, change_rate")
              .eq("ticker", ticker)
              .lte("date", on_date.isoformat())
              .order("date", desc=True)
              .limit(5)
              .execute().data
        ) or []
        kr_map = {r["date"]: float(r["change_rate"]) for r in kr_rows
                  if r.get("change_rate") is not None}
        kr_3d = self._compute_kr_change_3d(kr_map, on_date)

        return [
            latest.get("global_market_score") or 0.5,
            latest.get("sector_score") or 0.5,
            latest.get("related_us_stock_score") or 0.5,
            latest.get("news_sentiment_score") or 0.5,
            latest.get("fundamental_score") or 0.5,
            latest.get("volume_flow_score") or 0.5,
            latest.get("risk_penalty") or 0.5,
            ema3, mom5, kr_3d,
        ]

    @staticmethod
    def _compute_score_ema(series: list[dict], idx: int, span: int) -> float:
        """EMA of final_score over last `span` rows ending at idx."""
        alpha = 2.0 / (span + 1)
        ema = float(series[max(0, idx - span + 1)].get("final_score") or 0.5)
        for j in range(max(0, idx - span + 2), idx + 1):
            v = float(series[j].get("final_score") or 0.5)
            ema = alpha * v + (1 - alpha) * ema
        return ema

    @staticmethod
    def _compute_score_momentum(series: list[dict], idx: int, lookback: int) -> float:
        if idx - lookback < 0:
            return 0.0
        cur = float(series[idx].get("final_score") or 0.5)
        prev = float(series[idx - lookback].get("final_score") or 0.5)
        return cur - prev

    @staticmethod
    def _compute_kr_change_3d(kr_map: dict[str, float], on_date: Date) -> float:
        total = 0.0
        for i in range(1, 6):
            d = (on_date - timedelta(days=i)).isoformat()
            if d in kr_map:
                total += kr_map[d]
        return total                                    # cumulative simple sum, ~%

    @staticmethod
    def _roll_features(features: list[float], new_score: float) -> list[float]:
        """For recursive multi-step prediction: use the just-predicted
        score to update the score-derived features (ema3, momentum) for
        the next step. Exogenous features (sub_scores from US, news, etc.)
        are held constant — short-horizon assumption."""
        out = list(features)
        # Bump EMA3 toward new_score using α=0.5 (same as 3-EMA effective)
        out[7] = 0.5 * new_score + 0.5 * features[7]
        # Momentum: replace with latest delta (new_score - prev_ema3 proxy)
        out[8] = new_score - features[7]
        # kr_change_3d: hold (we don't predict prices, just scores)
        return out
