"""Korea Fear & Greed Index — KR-specific market sentiment composite.

A self-built alternative to CNN's Fear & Greed adapted for Korean
equity signals. Built from data already in Supabase (no new
collectors), so the daily pipeline picks it up for free.

Five components, each mapped to a 0–100 percentile (100 = max greed,
0 = max fear), then averaged. Missing components are excluded from the
mean; if fewer than three components are available, returns NEUTRAL
(50.0) so downstream subscore stays at 0.5 (no signal).

Components
----------
1. KOSPI Momentum   — ^KS11 close vs its 125-day SMA. Above = greed.
2. Volatility       — ^VIX 20-day mean vs 252-day band (low = greed).
                      (We use US VIX as a proxy for KR volatility
                      regime — V-KOSPI ingestion is out of scope here.)
3. Breadth          — % of watchlist stocks with close > 60-day SMA.
4. Foreign Flow     — Cumulative foreign net buy over the last 5
                      trading days across the watchlist, normalized
                      by the 60-day rolling std (z-score).
5. Safe Haven       — USDKRW 20-day realized volatility, percentile
                      against its 252-day band (high vol = fear).

The output is intentionally deterministic — no LLM in the loop. This
keeps the new 8th weight cheap to compute (≤ 200 ms) and reproducible
across backtest replays.

Used by cognition.scorer (subscore `kr_fear_greed`) and surfaced in
the admin UI as the 8th tunable weight.
"""
from __future__ import annotations

import logging
import math
import statistics
from dataclasses import dataclass, field
from datetime import date as Date

from agents.characters._data import (
    daily_quotes,
    global_quotes,
)
from db.supabase_client import get_admin_client

log = logging.getLogger(__name__)

NEUTRAL = 50.0  # 0..100 scale → maps to subscore 0.5
MIN_COMPONENTS = 3  # below this, fall back to NEUTRAL

# ──────────────────────────────────────────────────────────────────
# Result type
# ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class KrFearGreedResult:
    """Output of compute_kr_fg.

    `score` is on the 0..100 scale; the caller (cognition.scorer)
    divides by 100 to feed it into the 8th weighted subscore.
    `components` retains the per-component raw percentile (or None
    when data was insufficient) so we can surface a breakdown in the
    admin UI later without recomputing.
    """

    score: float
    components: dict[str, float | None] = field(default_factory=dict)
    regime: str = "정상"


def _regime_label(score: float) -> str:
    if score < 20:
        return "극단적 공포"
    if score < 40:
        return "공포"
    if score < 60:
        return "정상"
    if score < 80:
        return "탐욕"
    return "극단적 탐욕"


# ──────────────────────────────────────────────────────────────────
# Component helpers
# ──────────────────────────────────────────────────────────────────


def _percentile_rank(value: float, series: list[float]) -> float:
    """Where does `value` sit in `series` (sorted), 0..100.

    Ties resolved to the midpoint so identical historical values don't
    push percentile to 0 or 100 unfairly.
    """
    if not series:
        return NEUTRAL
    n = len(series)
    below = sum(1 for x in series if x < value)
    equal = sum(1 for x in series if x == value)
    return ((below + 0.5 * equal) / n) * 100.0


def _kospi_momentum(as_of: Date) -> float | None:
    """Component 1. KOSPI close vs its own 125-day SMA, percentile-
    ranked against the trailing 252-day distribution of the same ratio.
    Above 1 = greed (price stretched above MA), below = fear."""
    rows = global_quotes("^KS11", days=260, as_of=as_of)
    closes = [float(r.close) for r in rows if r.close is not None]
    if len(closes) < 130:
        return None
    # rows are newest-first; reverse for chronological math
    closes = list(reversed(closes))
    # rolling MA125 of the chronological series
    ratios: list[float] = []
    for i in range(125, len(closes)):
        ma = sum(closes[i - 125 : i]) / 125.0
        if ma > 0:
            ratios.append(closes[i] / ma)
    if not ratios:
        return None
    latest = ratios[-1]
    return _percentile_rank(latest, ratios)


def _volatility_band(as_of: Date) -> float | None:
    """Component 2. VIX 20-day mean, percentile-ranked against its
    252-day window. High VIX = fear, so we INVERT (100 - pct)."""
    rows = global_quotes("^VIX", days=260, as_of=as_of)
    closes = [float(r.close) for r in rows if r.close is not None]
    if len(closes) < 40:
        return None
    closes = list(reversed(closes))
    means: list[float] = []
    for i in range(20, len(closes)):
        means.append(sum(closes[i - 20 : i]) / 20.0)
    if not means:
        return None
    latest = means[-1]
    raw = _percentile_rank(latest, means)
    return 100.0 - raw  # high vol → low greed


def _breadth(as_of: Date) -> float | None:
    """Component 3. Fraction of watchlist tickers whose latest close
    sits above their own 60-day SMA. 1.0 = max greed."""
    sb = get_admin_client()
    res = (
        sb.table("stocks")
        .select("ticker")
        .eq("is_watchlist", True)
        .execute()
    )
    tickers = [r["ticker"] for r in (res.data or [])]
    if len(tickers) < 10:
        return None

    above = 0
    counted = 0
    for tk in tickers:
        quotes = daily_quotes(tk, days=70, as_of=as_of)
        closes = [float(q.close) for q in quotes if q.close is not None]
        if len(closes) < 60:
            continue
        chronological = list(reversed(closes))
        ma60 = sum(chronological[-60:]) / 60.0
        if chronological[-1] > ma60:
            above += 1
        counted += 1

    if counted < 10:
        return None
    return (above / counted) * 100.0


def _foreign_flow(as_of: Date) -> float | None:
    """Component 4. Cumulative foreign net buy across the watchlist
    over the trailing 5 trading days, z-scored against the trailing
    60-trading-day distribution of the same rolling sum.

    Positive z (net buying) = greed; we map z ∈ [-2, +2] → [0, 100].
    """
    sb = get_admin_client()
    res = (
        sb.table("stocks")
        .select("ticker")
        .eq("is_watchlist", True)
        .execute()
    )
    tickers = [r["ticker"] for r in (res.data or [])]
    if not tickers:
        return None

    # Aggregate per-day foreign net buy across watchlist
    by_date: dict[Date, int] = {}
    for tk in tickers:
        quotes = daily_quotes(tk, days=80, as_of=as_of)
        for q in quotes:
            if q.foreign_net_buy is None:
                continue
            by_date[q.date] = by_date.get(q.date, 0) + int(q.foreign_net_buy)
    if len(by_date) < 30:
        return None

    chronological = sorted(by_date.items())
    sums = [v for _d, v in chronological]
    # Rolling 5-day sums
    rolling: list[float] = []
    for i in range(5, len(sums) + 1):
        rolling.append(float(sum(sums[i - 5 : i])))
    if len(rolling) < 20:
        return None
    latest = rolling[-1]
    mean = statistics.fmean(rolling)
    stdev = statistics.pstdev(rolling)
    if stdev <= 0:
        return NEUTRAL
    z = (latest - mean) / stdev
    # Clamp + linear map z ∈ [-2, +2] → 0..100
    z = max(-2.0, min(2.0, z))
    return (z + 2.0) / 4.0 * 100.0


def _safe_haven(as_of: Date) -> float | None:
    """Component 5. USDKRW 20-day realized volatility, percentile-
    ranked vs 252-day window. High vol = risk-off = fear (so invert).
    """
    rows = global_quotes("USDKRW", days=260, as_of=as_of)
    closes = [float(r.close) for r in rows if r.close is not None]
    if len(closes) < 40:
        return None
    chrono = list(reversed(closes))
    # daily log returns
    rets: list[float] = []
    for i in range(1, len(chrono)):
        if chrono[i - 1] > 0 and chrono[i] > 0:
            rets.append(math.log(chrono[i] / chrono[i - 1]))
    if len(rets) < 40:
        return None
    # 20-day rolling stdev
    vols: list[float] = []
    for i in range(20, len(rets) + 1):
        window = rets[i - 20 : i]
        vols.append(statistics.pstdev(window))
    if not vols:
        return None
    latest = vols[-1]
    raw = _percentile_rank(latest, vols)
    return 100.0 - raw  # high vol → fear


# ──────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────


def compute_kr_fg(as_of: Date) -> KrFearGreedResult:
    """Compute the 5-component KR Fear & Greed score for `as_of`.

    Always returns a `KrFearGreedResult`. On total data failure the
    score falls back to NEUTRAL (50.0) and `regime="정상"` — the
    cognition layer then folds 0.5 into its weighted subscore, which
    is equivalent to "no signal from this factor".
    """
    components: dict[str, float | None] = {}
    try:
        components["kospi_momentum"] = _kospi_momentum(as_of)
    except Exception as exc:
        log.warning("kr_fg kospi_momentum failed: %s", exc)
        components["kospi_momentum"] = None
    try:
        components["volatility"] = _volatility_band(as_of)
    except Exception as exc:
        log.warning("kr_fg volatility failed: %s", exc)
        components["volatility"] = None
    try:
        components["breadth"] = _breadth(as_of)
    except Exception as exc:
        log.warning("kr_fg breadth failed: %s", exc)
        components["breadth"] = None
    try:
        components["foreign_flow"] = _foreign_flow(as_of)
    except Exception as exc:
        log.warning("kr_fg foreign_flow failed: %s", exc)
        components["foreign_flow"] = None
    try:
        components["safe_haven"] = _safe_haven(as_of)
    except Exception as exc:
        log.warning("kr_fg safe_haven failed: %s", exc)
        components["safe_haven"] = None

    valid = [v for v in components.values() if v is not None]
    if len(valid) < MIN_COMPONENTS:
        log.info(
            "kr_fg: only %d/%d components available — falling back to NEUTRAL",
            len(valid),
            len(components),
        )
        return KrFearGreedResult(
            score=NEUTRAL, components=components, regime=_regime_label(NEUTRAL)
        )

    score = statistics.fmean(valid)
    return KrFearGreedResult(
        score=score, components=components, regime=_regime_label(score)
    )


__all__ = ["KrFearGreedResult", "compute_kr_fg", "NEUTRAL"]


# ──────────────────────────────────────────────────────────────────
# Test-only injectable seam — lets unit tests bypass DB and exercise
# the aggregation logic directly. Not used in production.
# ──────────────────────────────────────────────────────────────────


def _aggregate_components(
    components: dict[str, float | None],
) -> KrFearGreedResult:
    """Pure aggregation step extracted for testing — no DB calls."""
    valid = [v for v in components.values() if v is not None]
    if len(valid) < MIN_COMPONENTS:
        return KrFearGreedResult(
            score=NEUTRAL, components=components, regime=_regime_label(NEUTRAL)
        )
    score = statistics.fmean(valid)
    return KrFearGreedResult(
        score=score, components=components, regime=_regime_label(score)
    )
