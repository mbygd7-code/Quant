"""Daily pipeline entrypoint — invoked by GitHub Actions runner.

Usage:
    python -m orchestrator.pipeline --mode=once --date=today
    python -m orchestrator.pipeline --mode=once --date=2026-05-06

The pipeline steps (collectors → refinery → cognition → signal → notifier)
are wired up incrementally in Prompts 02 through 06. This bootstrap version
only verifies environment + Supabase connectivity so the workflow can be
tested end-to-end before each module lands.
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from datetime import date as Date
from datetime import datetime
from zoneinfo import ZoneInfo

from db.supabase_client import verify_connection

KST = ZoneInfo("Asia/Seoul")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("orchestrator.pipeline")


def _parse_date(arg: str) -> Date:
    if arg == "today":
        return datetime.now(tz=KST).date()
    return Date.fromisoformat(arg)


def _require_runtime_env() -> None:
    """Refuse to start unless safety env vars are sane (CLAUDE.md §D)."""
    mode = os.environ.get("EXECUTION_MODE", "report_only")
    if mode not in {"report_only", "paper"}:
        raise SystemExit(
            f"Refusing to start: EXECUTION_MODE={mode!r}. "
            f"Live trading modes ('kis_real', 'kiwoom_real') require "
            f"explicit user approval — see CLAUDE.md §D."
        )
    log.info("EXECUTION_MODE=%s", mode)


def run_once(target: Date) -> int:
    """One-shot pipeline run for a given KST date. Returns process exit code."""
    log.info("=== QuantSignal pipeline start | target=%s (KST) ===", target.isoformat())
    _require_runtime_env()
    verify_connection()
    log.info("Supabase connection OK")

    # ── Step 1: Acquisition (Prompt 02) ────────────────────
    log.info("[1/5] Acquisition — collectors/")
    from collectors import FinnhubCollector, KrxCollector
    krx_result  = KrxCollector().fetch(target)
    finn_result = FinnhubCollector().fetch(target)
    log.info("Acquisition done — krx items=%d (success=%.1f%%), finnhub items=%d (success=%.1f%%)",
             krx_result.success_count, krx_result.success_rate * 100,
             finn_result.success_count, finn_result.success_rate * 100)

    # ── Step 2: Refinement (Prompt 03) ─────────────────────
    log.info("[2/5] Refinement — refinery/")
    from refinery import refine_all
    krx_report  = refine_all(krx_result,  source="krx",     on_date=target)
    finn_report = refine_all(finn_result, source="finnhub", on_date=target)
    if not krx_report.is_within_expected_range:
        log.warning("KRX discard rate %.1f%% out of [10%%, 20%%] band",
                    krx_report.discard_rate * 100)
    if not finn_report.is_within_expected_range:
        log.warning("Finnhub discard rate %.1f%% out of [10%%, 20%%] band",
                    finn_report.discard_rate * 100)

    # ── Step 3: Cognition (Prompt 04) ──────────────────────
    log.info("[3/5] Cognition — pending Prompt 04 (cognition/)")

    # ── Step 4: Signal (Prompt 05) ─────────────────────────
    log.info("[4/5] Signal — pending Prompt 05 (signals/)")

    # ── Step 5: Notify (Prompt 06) ─────────────────────────
    log.info("[5/5] Notify — pending Prompt 06 (notifier/)")

    log.info("=== Pipeline finished (skeleton) ===")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="QuantSignal daily pipeline")
    parser.add_argument(
        "--mode",
        choices=["once"],
        default="once",
        help="Currently only 'once' is supported (GitHub Actions invokes per-day).",
    )
    parser.add_argument(
        "--date",
        default="today",
        help="KST date (YYYY-MM-DD) or 'today'. Default: today.",
    )
    args = parser.parse_args()

    target = _parse_date(args.date)
    return run_once(target)


if __name__ == "__main__":
    sys.exit(main())
