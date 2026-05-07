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
    log.info("[4/6] Signal — LLM reports")
    from signals.report import generate_batch
    stats = await generate_batch(target)
    log.info("Report batch: %s", stats)
    return {"report_stats": stats}


async def step_intelligence(target: Date) -> dict:
    """Layer-2/3 intelligence outputs:
       (a) ML score predictions (5-day forecast curve via ScoreRegressor)
       (b) AI Quant Expert commentary (per-stock Korean note via Claude)

    Both are best-effort and non-fatal — pipeline still reaches Notify
    even if the ML retrain fails or Anthropic is throttling.
    """
    log.info("[5/6] Intelligence — ML predictions + AI commentary")
    from datetime import timedelta as _td
    from db.supabase_client import get_admin_client
    sb = get_admin_client()
    watchlist = (
        sb.table("stocks").select("ticker").eq("is_watchlist", True).execute().data
    ) or []
    tickers = [r["ticker"] for r in watchlist]

    metrics: dict = {}

    # ── (0) Sunday-only: refresh sector/macro ETF betas. They drift
    # slowly; daily recompute is wasted work. KST-Sunday is target.weekday()==6.
    if target.weekday() == 6:
        log.info("Sunday refresh — recomputing sector ETF + macro betas")
        try:
            from scripts.backfill_sector_etfs import main as etfs_main
            from scripts.compute_sector_betas import main as sector_main
            from scripts.backfill_macro_factors import main as macro_main
            from scripts.compute_macro_betas import main as macrobeta_main
            etfs_main(days=90)
            sector_main(window=60)
            macro_main(days=90)
            macrobeta_main(window=60)
            metrics["beta_refresh"] = "ok"
        except Exception as exc:
            log.warning("Beta refresh failed (non-fatal): %s", exc)
            metrics["beta_refresh"] = f"failed: {exc}"

    # ── (a) ML score predictions ──
    pred_rows = 0
    try:
        from signals.score_regressor import (
            InsufficientDataError, ScoreRegressor,
        )
        reg = ScoreRegressor()
        train_end = target - _td(days=1)
        train_start = train_end - _td(days=60)
        train_info = reg.train(train_start, train_end)
        log.info("ScoreRegressor: %s", train_info)
        upserts: list[dict] = []
        for ticker in tickers:
            preds = reg.predict_horizon(ticker, target, horizon_days=5)
            for p in preds:
                upserts.append({
                    "date":            p.date.isoformat(),
                    "ticker":          p.ticker,
                    "horizon_day":     p.horizon_day,
                    "target_date":     p.target_date.isoformat(),
                    "predicted_score": p.predicted_score,
                    "lower_95":        p.lower_95,
                    "upper_95":        p.upper_95,
                    "model_version":   p.model_version,
                })
        if upserts:
            sb.table("score_predictions").upsert(
                upserts, on_conflict="date,ticker,horizon_day",
            ).execute()
            pred_rows = len(upserts)
        log.info("score_predictions upserted: %d", pred_rows)
    except InsufficientDataError as exc:
        log.warning("ScoreRegressor needs more history: %s", exc)
    except Exception as exc:
        log.warning("ML predictions step failed (non-fatal): %s", exc)
    metrics["predictions"] = pred_rows

    # ── (b) AI commentary (Haiku 4-5) ──
    completed = 0
    failed = 0
    try:
        import asyncio as _asyncio
        from cognition.commentary import CommentaryEngine
        engine = CommentaryEngine()

        # Pre-fetch context (scores + quote + fundamental + news)
        score_rows = (
            sb.table("ai_scores").select("*, stocks(name, sector)")
              .eq("date", target.isoformat()).execute().data
        ) or []
        existing = {
            r["ticker"] for r in (
                sb.table("ai_commentary").select("ticker")
                  .eq("date", target.isoformat()).execute().data or []
            )
        }
        todo = [r for r in score_rows if r["ticker"] not in existing]
        if not todo:
            log.info("ai_commentary already complete for %s", target)
            metrics["commentary"] = 0
            return metrics

        quote_rows = (
            sb.table("korea_market").select("ticker, close, change_rate, volume")
              .eq("date", target.isoformat())
              .in_("ticker", [r["ticker"] for r in todo])
              .execute().data
        ) or []
        quote_by_ticker = {r["ticker"]: r for r in quote_rows}

        fund_rows = (
            sb.table("kr_financials")
              .select("ticker, revenue_yoy, op_income_yoy")
              .in_("ticker", [r["ticker"] for r in todo])
              .order("period_end", desc=True).execute().data
        ) or []
        fund_by_ticker: dict = {}
        for r in fund_rows:
            fund_by_ticker.setdefault(r["ticker"], r)
        fpe_rows = (
            sb.table("kr_fundamentals").select("ticker, forward_pe, roe")
              .in_("ticker", [r["ticker"] for r in todo])
              .order("date", desc=True).execute().data
        ) or []
        fpe_by_ticker: dict = {}
        for r in fpe_rows:
            fpe_by_ticker.setdefault(r["ticker"], r)

        since3 = (target - _td(days=3)).isoformat()
        news_rows = (
            sb.table("news_items").select("title, related_symbols")
              .gte("date", since3).lte("date", target.isoformat())
              .not_.is_("title", "null").execute().data
        ) or []
        news_by_ticker: dict[str, list[str]] = {}
        for r in news_rows:
            for sym in (r.get("related_symbols") or []):
                lst = news_by_ticker.setdefault(sym, [])
                if len(lst) < 5:
                    lst.append(r["title"])

        sem = _asyncio.Semaphore(4)

        async def process(score_row: dict) -> None:
            nonlocal completed, failed
            ticker = score_row["ticker"]
            meta = score_row.get("stocks") or {}
            sub = {
                "global_market":     score_row.get("global_market_score"),
                "sector":            score_row.get("sector_score"),
                "related_us_stock":  score_row.get("related_us_stock_score"),
                "news_sentiment":    score_row.get("news_sentiment_score"),
                "fundamental":       score_row.get("fundamental_score"),
                "volume_flow":       score_row.get("volume_flow_score"),
                "risk_penalty":      score_row.get("risk_penalty"),
            }
            fund_data: dict = {}
            if ticker in fund_by_ticker:
                fund_data.update(fund_by_ticker[ticker])
            if ticker in fpe_by_ticker:
                fund_data["forward_pe"] = fpe_by_ticker[ticker].get("forward_pe")
                fund_data["roe"] = fpe_by_ticker[ticker].get("roe")
            payload = {
                "ticker": ticker, "name": meta.get("name"),
                "sector": meta.get("sector"),
                "score": {
                    "signal":      score_row.get("signal"),
                    "final_score": score_row.get("final_score"),
                    "sub_scores":  sub,
                },
                "quote":       quote_by_ticker.get(ticker),
                "fundamental": fund_data,
                "recent_news": news_by_ticker.get(ticker, []),
            }
            async with sem:
                try:
                    c = await engine.generate(payload)
                except Exception as e:
                    log.warning("commentary[%s] failed: %s", ticker, e)
                    failed += 1
                    return
                sb.table("ai_commentary").upsert({
                    "date":          target.isoformat(),
                    "ticker":        ticker,
                    "headline":      c.headline,
                    "body":          c.body,
                    "short_term":    c.short_term,
                    "mid_term":      c.mid_term,
                    "catalysts":     c.catalysts,
                    "risks":         c.risks,
                    "model":         "claude-haiku-4-5",
                    "cost_estimate": 0.005,
                }, on_conflict="date,ticker").execute()
                completed += 1

        await _asyncio.gather(*(process(r) for r in todo))
        log.info("ai_commentary: completed=%d failed=%d", completed, failed)
    except Exception as exc:
        log.warning("Commentary step failed (non-fatal): %s", exc)
    metrics["commentary"] = completed
    metrics["commentary_failed"] = failed
    return metrics


async def step_notify(target: Date) -> dict:
    log.info("[6/6] Notify — telegram dispatcher + preview upload")
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
        intel = await step_intelligence(target)
        metrics.update(intel)
    except Exception as exc:
        log.exception("Step 5 (intelligence) failed (non-fatal): %s", exc)

    try:
        ntf = await step_notify(target)
        metrics.update(ntf)
    except Exception as exc:
        log.exception("Step 6 failed: %s", exc)

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
              "report_stats", "beta_refresh", "predictions", "commentary",
              "commentary_failed", "notify"):
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
