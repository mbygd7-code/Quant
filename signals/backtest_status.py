"""CLI to update backtest_jobs row from .github/workflows/backtest.yml.

Three usage forms:
    python -m signals.backtest_status --job-id=<uuid> --status=running --run-url=<url>
    python -m signals.backtest_status --job-id=<uuid> --status=completed
    python -m signals.backtest_status --job-id=<uuid> --status=failed --error="..."
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime

from db.supabase_client import get_admin_client

log = logging.getLogger("signals.backtest_status")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--status", required=True,
                        choices=["queued", "running", "completed", "failed"])
    parser.add_argument("--run-url", default=None)
    parser.add_argument("--error", default=None)
    args = parser.parse_args()

    update: dict = {"status": args.status}
    if args.run_url:
        update["run_url"] = args.run_url
    if args.error:
        update["error"] = args.error[:1000]
    if args.status == "running":
        update["started_at"] = datetime.utcnow().isoformat()
    if args.status in ("completed", "failed"):
        update["completed_at"] = datetime.utcnow().isoformat()

    sb = get_admin_client()
    sb.table("backtest_jobs").update(update).eq("id", args.job_id).execute()
    log.info("backtest_jobs[%s] -> %s", args.job_id, args.status)
    return 0


if __name__ == "__main__":
    sys.exit(main())
