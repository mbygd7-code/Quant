"""KR trade momentum subscore — 수출입 동향 (9th factor).

Converts the sector's monthly export YoY into a 0..1 subscore by
percentile-ranking the latest *published* month against the trailing
24 months of that sector's YoY history.

Design constraints (from the 2026-06 validation):
  • Export data is COINCIDENT with stock prices (ρ≈+0.4 same-month),
    not predictive (ρ≈+0.30, n.s.) — this factor CONFIRMS trends.
  • Publication lag: month M is finalized ~the 15th of M+1 (관세청
    확정치). We therefore only use periods where `on_date` is past the
    16th of the following month — no look-ahead bias.
  • YoY distribution is regime-skewed (반도체 +150%+ super-cycle since
    2025-10), so percentile rank — not z-score or raw value — is the
    right normalization.
  • Missing data (no API key yet, unknown sector, short history)
    → NEUTRAL 0.5, per ABSOLUTE RULE B (never fabricate).
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date as Date

from collectors.kr_trade import SECTOR_HS
from db.supabase_client import fetch_all, get_admin_client

log = logging.getLogger("signals.kr_trade")

NEUTRAL = 0.5
#: Trailing window of monthly YoY values for the percentile rank.
RANK_WINDOW = 24
#: Need at least this many history points for a meaningful percentile.
MIN_HISTORY = 8


@dataclass
class KrTradeResult:
    score: float                      # 0..1
    sector: str | None = None
    latest_period: str | None = None  # 'YYYY-MM'
    latest_yoy: float | None = None
    n_history: int = 0
    detail: dict = field(default_factory=dict)


def latest_published_period(on_date: Date) -> str:
    """Most recent month whose finalized stats are public on `on_date`.

    Month M is published ~15th of M+1; we add a 1-day buffer (16th).
    """
    y, m = on_date.year, on_date.month
    if on_date.day >= 16:
        # last month's data is out
        m -= 1
    else:
        # only data through two months ago is out
        m -= 2
    while m <= 0:
        m += 12
        y -= 1
    return f"{y}-{m:02d}"


def compute_kr_trade(sector: str | None, on_date: Date) -> KrTradeResult:
    """Percentile rank of the sector's latest export YoY vs trailing 24m."""
    if not sector or sector not in SECTOR_HS:
        return KrTradeResult(score=NEUTRAL, sector=sector)

    hs_codes = SECTOR_HS[sector]
    cutoff = latest_published_period(on_date)
    sb = get_admin_client()
    rows = fetch_all(
        sb.table("kr_trade_stats")
        .select("hs_code, period, export_usd")
        .in_("hs_code", hs_codes)
        .lte("period", cutoff)
        .order("period")
    )
    if not rows:
        return KrTradeResult(score=NEUTRAL, sector=sector)

    # Aggregate export value across the sector's HS codes per month,
    # then compute YoY on the aggregate (more stable than averaging
    # per-code YoY when code sizes differ by 10x, e.g. 8542 vs 8541).
    by_period: dict[str, int] = {}
    for r in rows:
        if r.get("export_usd") is not None:
            by_period[r["period"]] = by_period.get(r["period"], 0) + r["export_usd"]

    periods = sorted(by_period)
    yoy: dict[str, float] = {}
    for p in periods:
        y, m = int(p[:4]), int(p[5:7])
        base = f"{y - 1}-{m:02d}"
        if base in by_period and by_period[base] > 0:
            yoy[p] = (by_period[p] - by_period[base]) / by_period[base] * 100

    if not yoy:
        return KrTradeResult(score=NEUTRAL, sector=sector)

    latest = max(yoy)
    history = [yoy[p] for p in sorted(yoy)[-RANK_WINDOW:]]
    if len(history) < MIN_HISTORY:
        log.info("[kr_trade] %s: only %d months of YoY — NEUTRAL", sector, len(history))
        return KrTradeResult(
            score=NEUTRAL, sector=sector, latest_period=latest,
            latest_yoy=round(yoy[latest], 2), n_history=len(history),
        )

    latest_val = yoy[latest]
    below = sum(1 for v in history if v < latest_val)
    equal = sum(1 for v in history if v == latest_val)
    # Midrank percentile in (0,1); a median value lands at 0.5.
    pct = (below + 0.5 * equal) / len(history)

    return KrTradeResult(
        score=max(0.0, min(1.0, pct)),
        sector=sector,
        latest_period=latest,
        latest_yoy=round(latest_val, 2),
        n_history=len(history),
        detail={"percentile": round(pct, 3)},
    )
