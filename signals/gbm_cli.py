"""CLI:
    python -m signals.gbm_cli train --start=2026-01-01 --end=2026-04-30
    python -m signals.gbm_cli predict --date=2026-05-06

Train mode requires >= 200 labeled rows; otherwise InsufficientDataError.
Predict mode loads the latest fitted model from memory (Phase 2 will move
serialized models to Supabase Storage).
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo

from db.supabase_client import get_admin_client
from signals.gbm import GBMPredictor

KST = ZoneInfo("Asia/Seoul")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("signals.gbm_cli")


def _parse_date(s: str) -> Date:
    if s == "today":
        return datetime.now(tz=KST).date()
    return Date.fromisoformat(s)


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_train = sub.add_parser("train")
    p_train.add_argument("--start", required=True)
    p_train.add_argument("--end", required=True)

    p_pred = sub.add_parser("predict")
    p_pred.add_argument("--date", default="today")

    args = parser.parse_args()
    pred = GBMPredictor()

    if args.cmd == "train":
        result = pred.train(_parse_date(args.start), _parse_date(args.end))
        log.info("Trained on %d rows. CV mean accuracy=%.3f",
                 result.rows, result.cv_auc_mean)
        log.info("Top features: %s",
                 sorted(result.feature_importances.items(), key=lambda kv: -kv[1])[:5])
        return 0

    if args.cmd == "predict":
        target = _parse_date(args.date)
        sb = get_admin_client()
        tickers = [
            r["ticker"] for r in (
                sb.table("stocks").select("ticker").eq("is_watchlist", True)
                  .execute().data or []
            )
        ]
        # Predict mode requires a trained model. CLI use is for ad-hoc
        # validation only; orchestrator calls .train() then .predict().
        log.warning("CLI predict requires a previously fitted model in memory; "
                    "use the orchestrator pipeline for end-to-end runs.")
        for ticker in tickers[:3]:
            try:
                p = pred.predict(ticker, target)
                log.info("%s: prob_up=%.3f confidence=%.3f", ticker, p.prob_up, p.model_confidence)
            except Exception as exc:
                log.warning("%s: %s", ticker, exc)
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
