"""KR / US business-day calculations.

Wraps `pandas_market_calendars` so the rest of the codebase has a tiny,
pandas-free API surface. The pipeline always asks "what is the previous
trading day for KRX / NYSE relative to a given KST date?" — that's all.
"""
from __future__ import annotations

from datetime import date as Date
from datetime import datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

import pandas_market_calendars as mcal

KST = ZoneInfo("Asia/Seoul")
ET = ZoneInfo("America/New_York")

# 충분한 lookback 윈도. 연휴(설/추석/Thanksgiving 주간) 안전.
_LOOKBACK_DAYS = 14


@lru_cache(maxsize=4)
def _calendar(name: str):
    return mcal.get_calendar(name)


def _last_trading_day(calendar_name: str, on_or_before: Date) -> Date:
    """Return the last trading day on `calendar_name` that is <= on_or_before."""
    cal = _calendar(calendar_name)
    start = on_or_before - timedelta(days=_LOOKBACK_DAYS)
    sched = cal.schedule(start_date=start.isoformat(), end_date=on_or_before.isoformat())
    if sched.empty:
        raise ValueError(
            f"No trading days for {calendar_name} between "
            f"{start.isoformat()} and {on_or_before.isoformat()}"
        )
    return sched.index[-1].date()


def prev_kr_business_day(reference: Date) -> Date:
    """Previous KRX trading day strictly before `reference` (KST date).

    Used by KRX collector — pipeline runs at 06:00 KST, so 'today's' market
    data does not exist yet; we want yesterday's close.
    """
    return _last_trading_day("XKRX", reference - timedelta(days=1))


def prev_us_business_day(reference_kst: Date) -> Date:
    """Previous US trading day whose close is fully available at 06:00 KST.

    06:00 KST corresponds to 16:00 ET (previous calendar day) which is right
    after NYSE close. So if KST 'reference_kst' is e.g. 2026-05-06 (Wed),
    the most recent fully-closed US session is 2026-05-05 (Tue) ET.
    """
    et_now = datetime.combine(reference_kst, datetime.min.time(), tzinfo=KST).astimezone(ET)
    return _last_trading_day("XNYS", et_now.date())


def is_kr_trading_day(d: Date) -> bool:
    cal = _calendar("XKRX")
    sched = cal.schedule(start_date=d.isoformat(), end_date=d.isoformat())
    return not sched.empty
