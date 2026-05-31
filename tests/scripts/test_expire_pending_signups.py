"""Tests for the elapsed-business-days math in expire_pending_signups."""
from __future__ import annotations

from datetime import date

from scripts.expire_pending_signups import (
    APPROVAL_SLA_BUSINESS_DAYS,
    elapsed_business_days,
)


class TestElapsedBusinessDays:
    # July 6-13 2026: Mon-Mon, no Korean holidays in range.

    def test_same_day_returns_zero(self):
        assert elapsed_business_days(date(2026, 7, 6), date(2026, 7, 6)) == 0

    def test_one_business_day(self):
        # Mon 7/6 -> Tue 7/7 = 1 business day elapsed
        assert elapsed_business_days(date(2026, 7, 6), date(2026, 7, 7)) == 1

    def test_skips_weekend(self):
        # Fri 7/10 -> Mon 7/13 = 1 biz day (Sat/Sun skipped)
        assert elapsed_business_days(date(2026, 7, 10), date(2026, 7, 13)) == 1

    def test_five_business_days(self):
        # Mon 7/6 -> Mon 7/13 = 5 biz days (Tue 7-Fri 10, Mon 13)
        assert elapsed_business_days(date(2026, 7, 6), date(2026, 7, 13)) == 5

    def test_end_before_start_returns_zero(self):
        assert elapsed_business_days(date(2026, 7, 8), date(2026, 7, 6)) == 0

    def test_holiday_correctly_skipped(self):
        # 2026-05-25 (Mon) is Buddha's Birthday makeup holiday — KRX closed.
        # Fri 5/22 -> Tue 5/26 should be 1 biz day (Mon 25 excluded).
        assert elapsed_business_days(date(2026, 5, 22), date(2026, 5, 26)) == 1

    def test_sla_threshold_constant(self):
        """Doc-test: SLA must match what /pending UI displays."""
        assert APPROVAL_SLA_BUSINESS_DAYS == 5
