"""Daily pipeline entrypoint — invoked by GitHub Actions runner.

    python -m orchestrator.pipeline --mode=once --date=today
    python -m orchestrator.pipeline --mode=once --date=2026-05-06

Five steps run in order. Each is wrapped so a single-step failure is
captured + logged + reported but does not abort downstream steps that can
still produce useful output. The exception is Step 0 (env + Supabase
connectivity) — those failures abort.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo

from db.supabase_client import verify_connection
from executor.safety import SecurityError, check_execution_mode

KST = ZoneInfo("Asia/Seoul")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("orchestrator.pipeline")


# ──────────────────────────────────────────────────────────
# Step functions — each returns a small dict of metrics
# ──────────────────────────────────────────────────────────
def step_acquisition(target: Date) -> dict:
    log.info("[1/5] Acquisition — collectors/")
    from collectors import FinnhubCollector, KrxCollector
    krx = KrxCollector().fetch(target)
    finn = FinnhubCollector().fetch(target)
    log.info("Acquisition done — krx items=%d (success=%.1f%%), finnhub items=%d (success=%.1f%%)",
             krx.success_count, krx.success_rate * 100,
             finn.success_count, finn.success_rate * 100)
    return {"krx_result": krx, "finnhub_result": finn}


def step_refinement(target: Date, krx_result, finnhub_result) -> dict:
    log.info("[2/5] Refinement — refinery/")
    from refinery import refine_all
    krx_report = refine_all(krx_result, source="krx", on_date=target)
    finn_report = refine_all(finnhub_result, source="finnhub", on_date=target)
    if not krx_report.is_within_expected_range:
        log.warning("⚠️ KRX discard rate %.1f%% out of [10%%, 20%%] band",
                    krx_report.discard_rate * 100)
    if not finn_report.is_within_expected_range:
        log.warning("⚠️ Finnhub discard rate %.1f%% out of [10%%, 20%%] band",
                    finn_report.discard_rate * 100)
    return {"krx_report": krx_report, "finn_report": finn_report}


async def step_cognition(target: Date) -> dict:
    """Sentiment + embedding for unscored news, then per-ticker scoring."""
    log.info("[3/5] Cognition — sentiment + scoring")
    from cognition.scorer import StockScorer, upsert_score
    from cognition.sentiment import SentimentEngine
    from db.supabase_client import get_admin_client

    # 3a) news sentiment + embeddings (skips already-scored rows)
    sentiment_engine = SentimentEngine()
    sentiment_stats = await sentiment_engine.score_batch(target)
    log.info("Sentiment batch: %s", sentiment_stats)

    # 3b) per-ticker scoring (50 watchlist tickers)
    sb = get_admin_client()
    tickers = [
        r["ticker"] for r in (
            sb.table("stocks").select("ticker").eq("is_watchlist", True)
              .execute().data or []
        )
    ]
    scorer = StockScorer()
    success, failed = 0, 0
    for ticker in tickers:
        try:
            score = scorer.score(ticker, target)
            upsert_score(score)
            success += 1
        except Exception as exc:
            log.warning("score(%s) failed: %s", ticker, exc)
            failed += 1
    log.info("Scoring: success=%d failed=%d", success, failed)
    return {"sentiment": sentiment_stats, "scoring_success": success, "scoring_failed": failed}


async def step_signal(target: Date) -> dict:
    """Generate LLM reports for each ai_score, replacing the stub rationale_json."""
    log.info("[4/5] Signal — LLM reports")
    from signals.report import generate_batch
    stats = await generate_batch(target)
    log.info("Report batch: %s", stats)
    return {"report_stats": stats}


async def step_notify(target: Date) -> dict:
    log.info("[5/5] Notify — telegram dispatcher + preview upload")
    from notifier.dispatcher import NotificationDispatcher
    from signals.preview_report import upload_preview

    # Storage backup of preview markdown (used by Web app archives too).
    try:
        path = upload_preview(target)
        log.info("Preview uploaded: %s", path)
    except Exception as exc:
        log.warning("preview upload failed (non-fatal): %s", exc)

    dispatcher = NotificationDispatcher()
    stats = await dispatcher.dispatch(target)
    log.info("Notify done: %s", stats)
    return {"notify": stats}


# ──────────────────────────────────────────────────────────
# Top-level run
# ──────────────────────────────────────────────────────────
def _parse_date(arg: str) -> Date:
    if arg == "today":
        return datetime.now(tz=KST).date()
    return Date.fromisoformat(arg)


async def _run_once_async(target: Date) -> int:
    log.info("=== QuantSignal pipeline start | target=%s (KST) ===", target.isoformat())
    try:
        check_execution_mode()
    except SecurityError as exc:
        log.error("Refusing to start: %s", exc)
        return 2

    try:
        verify_connection()
        log.info("Supabase connection OK")
    except SystemExit as exc:
        log.error("Supabase verify failed: %s", exc)
        return 3

    metrics: dict[str, dict] = {}

    # Each step is best-effort; log + continue on failure.
    try:
        acq = step_acquisition(target)
        metrics.update(acq)
    except Exception as exc:
        log.exception("Step 1 failed; aborting (no data to refine): %s", exc)
        return 4

    try:
        ref = step_refinement(target, acq["krx_result"], acq["finnhub_result"])
        metrics.update(ref)
    except Exception as exc:
        log.exception("Step 2 failed: %s", exc)

    try:
        cog = await step_cognition(target)
        metrics.update(cog)
    except Exception as exc:
        log.exception("Step 3 failed: %s", exc)

    try:
        sig = await step_signal(target)
        metrics.update(sig)
    except Exception as exc:
        log.exception("Step 4 failed: %s", exc)

    try:
        ntf = await step_notify(target)
        metrics.update(ntf)
    except Exception as exc:
        log.exception("Step 5 failed: %s", exc)

    log.info("=== Pipeline finished | metrics=%s", _summarize_metrics(metrics))
    return 0


def _summarize_metrics(m: dict) -> dict:
    """Compact log-friendly summary; drop heavy CollectorResult/RefineryReport objects."""
    out: dict = {}
    if "krx_result" in m:
        r = m["krx_result"]
        out["krx_acq"] = {"items": r.success_count, "failed": r.failure_count}
    if "finnhub_result" in m:
        r = m["finnhub_result"]
        out["finn_acq"] = {"items": r.success_count, "failed": r.failure_count}
    if "krx_report" in m:
        r = m["krx_report"]
        out["krx_ref"] = {"accepted": r.accepted, "discarded": r.discarded,
                          "discard_pct": round(r.discard_rate * 100, 1)}
    if "finn_report" in m:
        r = m["finn_report"]
        out["finn_ref"] = {"accepted": r.accepted, "discarded": r.discarded}
    for k in ("sentiment", "scoring_success", "scoring_failed",
              "report_stats", "notify"):
        if k in m:
            out[k] = m[k]
    return out


def run_once(target: Date) -> int:
    return asyncio.run(_run_once_async(target))


def main() -> int:
    parser = argparse.ArgumentParser(description="QuantSignal daily pipeline")
    parser.add_argument("--mode", choices=["once"], default="once",
        help="Currently only 'once' is supported (GitHub Actions invokes per-day).")
    parser.add_argument("--date", default="today",
        help="KST date (YYYY-MM-DD) or 'today'. Default: today.")
    args = parser.parse_args()

    return run_once(_parse_date(args.date))


if __name__ == "__main__":
    sys.exit(main())
