"""Expire pending signups whose 5-business-day SLA window has elapsed.

Runs daily from .github/workflows/expire-pending-signups.yml. Reads
profiles where approval_status='pending' and flips the row to 'expired'
when the elapsed business days since the start (reapplied_at if set,
else created_at) crosses the SLA threshold.

CLAUDE.md §3-E: uses service_role via db.supabase_client.get_admin_client
— never call from a user-facing context.

Usage:
  python -m scripts.expire_pending_signups [--dry-run]
"""
from __future__ import annotations

import argparse
import logging
from datetime import UTC, datetime
from datetime import date as Date

import pandas_market_calendars as mcal

from db.supabase_client import get_admin_client

log = logging.getLogger(__name__)

APPROVAL_SLA_BUSINESS_DAYS = 5
KRX_CALENDAR = mcal.get_calendar("XKRX")  # Korea Exchange


def _today_kst() -> Date:
    """Today in KST (KRX local time)."""
    # GitHub Actions runs in UTC; KST = UTC+9. Using UTC date is close
    # enough since this job runs at 00:00 UTC = 09:00 KST and we only
    # care about whole-business-day counts.
    return datetime.now(UTC).date()


def elapsed_business_days(start: Date, end: Date) -> int:
    """Count KRX business days strictly after `start` up to and
    including `end`. Returns 0 when `end <= start`."""
    if end <= start:
        return 0
    schedule = KRX_CALENDAR.valid_days(
        start_date=start.isoformat(),
        end_date=end.isoformat(),
    )
    # `valid_days` includes both endpoints. We want the count of
    # business days that have *passed* since `start` (exclusive of the
    # start day, inclusive of today). Subtract 1 if `start` itself was
    # a business day and is in the range.
    count = len(schedule)
    if count == 0:
        return 0
    start_iso = start.isoformat()
    if any(d.strftime("%Y-%m-%d") == start_iso for d in schedule):
        count -= 1
    return max(0, count)


def expire_pending(dry_run: bool = False) -> dict[str, int]:
    sb = get_admin_client()
    res = (
        sb.table("profiles")
        .select("id, email, created_at, reapplied_at, reapply_count")
        .eq("approval_status", "pending")
        .execute()
    )
    rows = res.data or []
    today = _today_kst()

    expired_count = 0
    expired_emails: list[str] = []

    for r in rows:
        start_iso = r.get("reapplied_at") or r.get("created_at")
        if not start_iso:
            continue
        start = datetime.fromisoformat(start_iso.replace("Z", "+00:00")).date()
        elapsed = elapsed_business_days(start, today)
        if elapsed < APPROVAL_SLA_BUSINESS_DAYS:
            continue

        expired_count += 1
        expired_emails.append(r["email"])
        log.info(
            "EXPIRE %s — %d business days since %s (SLA %d)",
            r["email"],
            elapsed,
            start.isoformat(),
            APPROVAL_SLA_BUSINESS_DAYS,
        )

        if not dry_run:
            sb.table("profiles").update(
                {
                    "approval_status": "expired",
                    "approval_note": (
                        f"영업일 {APPROVAL_SLA_BUSINESS_DAYS}일 이내 관리자 검토 미완료로 자동 만료"
                    ),
                }
            ).eq("id", r["id"]).execute()
            sb.table("audit_logs").insert(
                {
                    "user_id": r["id"],
                    "action": "user.auto_expire",
                    "resource_type": "profiles",
                    "resource_id": r["id"],
                    "changes": {
                        "elapsed_business_days": elapsed,
                        "sla_days": APPROVAL_SLA_BUSINESS_DAYS,
                        "started_at": start.isoformat(),
                    },
                }
            ).execute()

    return {
        "scanned": len(rows),
        "expired": expired_count,
        "dry_run": int(dry_run),
    }


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would be expired without writing to DB.",
    )
    args = parser.parse_args()

    stats = expire_pending(dry_run=args.dry_run)
    log.info(
        "Done: scanned=%d expired=%d dry_run=%d",
        stats["scanned"],
        stats["expired"],
        stats["dry_run"],
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
