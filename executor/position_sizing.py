"""Position sizing engine — conviction × inverse-volatility with pro-grade caps.

Replaces the naive equal-slot (equity/10) sizing. The construction
follows the documented practice of professional discretionary/quant
managers (sources in docs/paper-sizing.md and the /paper strategy card):

  1. CONVICTION  — Druckenmiller/Soros doctrine: size up what you
     believe in, stay small on marginal ideas. Conviction comes from
     the Soros consensus (grade + weighted_score + voter agreement).
  2. RISK PARITY (lite) — inverse-volatility scaling so one position's
     bad day doesn't dominate the book (equal-risk-contribution family).
  3. RISK PER POSITION — vol-cap each name so a 2σ daily move costs at
     most RISK_PER_POSITION of equity (the "1-2% rule" / Turtle ATR
     sizing translated to σ).
  4. FRACTIONAL KELLY POSTURE — caps everywhere; full-Kelly style
     aggressiveness is documented to be ruinous in practice (Thorp).
  5. CONCENTRATION CAPS — single-name and sector ceilings, minimum
     ticket (no dust positions).
  6. DRAWDOWN THROTTLE — after a meaningful drawdown from the equity
     peak, new deployment halves until the book recovers ("when it
     hurts, get smaller").

All functions here are PURE (no I/O) so the policy is unit-testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class SizingParams:
    #: Target invested fraction of equity in full risk-on (rest = cash buffer).
    invest_fraction: float = 0.90
    #: Max loss budget per position for a 2σ daily move, as equity fraction.
    risk_per_position: float = 0.015
    #: Hard single-name ceiling (fraction of equity).
    single_cap: float = 0.20
    #: Sector ceiling (fraction of equity).
    sector_cap: float = 0.40
    #: Minimum ticket (fraction of equity) — below this, skip (dust).
    min_ticket: float = 0.03
    #: Drawdown (from equity peak) beyond which new deployment halves.
    throttle_drawdown: float = 0.08
    #: Conviction multiplier per signal grade.
    grade_mult: dict = field(
        default_factory=lambda: {"STRONG_BUY": 1.0, "BUY": 0.65}
    )
    #: Floor for σ so a freakishly quiet name can't grab the whole book.
    sigma_floor: float = 0.008


@dataclass(frozen=True)
class Candidate:
    ticker: str
    sector: str | None
    grade: str
    weighted_score: float  # -2..+2 (Soros Q2-adjusted)
    confidence: float      # 0..1 voter agreement
    sigma_daily: float     # daily log-return stdev


def conviction(c: Candidate, params: SizingParams) -> float:
    """0..1 — how much we believe in this name.

    grade sets the band, |score| and voter agreement refine within it.
    A STRONG_BUY at full score & agreement → 1.0; a marginal BUY with
    weak agreement → ~0.3.
    """
    g = params.grade_mult.get(c.grade, 0.0)
    if g <= 0:
        return 0.0
    score_term = min(1.0, max(0.0, abs(c.weighted_score) / 2.0))
    conf_term = 0.5 + 0.5 * min(1.0, max(0.0, c.confidence))
    return g * (0.4 + 0.6 * score_term) * conf_term


def deploy_fraction(
    params: SizingParams, *, risk_on: bool, drawdown: float
) -> float:
    """How much of equity the book may target right now."""
    if not risk_on:
        return 0.0
    f = params.invest_fraction
    if drawdown >= params.throttle_drawdown:
        f *= 0.5
    return f


def target_budgets(
    candidates: list[Candidate],
    *,
    equity: int,
    free_cash: int,
    held_weights: dict[str, float],          # ticker → current weight
    held_sector_weights: dict[str, float],   # sector → current weight
    risk_on: bool,
    drawdown: float,
    params: SizingParams | None = None,
) -> dict[str, int]:
    """KRW budget per NEW candidate, respecting every cap.

    Existing positions consume book + sector room; new candidates split
    the remaining deployment in proportion to conviction/σ (risk-scaled
    conviction), each clipped by:
      · vol cap   risk_per_position / (2σ)
      · single-name cap
      · remaining sector room
      · free cash
    and dropped when below the minimum ticket.
    """
    params = params or SizingParams()
    if equity <= 0 or not candidates:
        return {}
    f = deploy_fraction(params, risk_on=risk_on, drawdown=drawdown)
    if f <= 0:
        return {}

    invested_w = sum(held_weights.values())
    room = max(0.0, f - invested_w)
    if room <= 0:
        return {}

    scored = []
    for c in candidates:
        conv = conviction(c, params)
        if conv <= 0:
            continue
        sigma = max(c.sigma_daily, params.sigma_floor)
        scored.append((c, conv / sigma))
    if not scored:
        return {}
    total_raw = sum(raw for _, raw in scored)

    sector_used = dict(held_sector_weights)
    budgets: dict[str, int] = {}
    cash_left = free_cash
    # Highest risk-scaled conviction first — if caps bind, the strongest
    # ideas get filled first (the Druckenmiller ordering).
    for c, raw in sorted(scored, key=lambda x: -x[1]):
        w = room * raw / total_raw
        sigma = max(c.sigma_daily, params.sigma_floor)
        vol_cap = params.risk_per_position / (2.0 * sigma)
        # The single-name ceiling scales with conviction — only a
        # full-conviction name may reach the hard cap (Druckenmiller:
        # size what you believe). A marginal BUY tops out around 9%.
        conv = conviction(c, params)
        conv_cap = params.single_cap * (0.4 + 0.6 * conv)
        w = min(w, vol_cap, conv_cap)
        if c.sector:
            sector_room = params.sector_cap - sector_used.get(c.sector, 0.0)
            w = min(w, max(0.0, sector_room))
        budget = int(min(w * equity, cash_left))
        if budget < params.min_ticket * equity:
            continue
        budgets[c.ticker] = budget
        cash_left -= budget
        if c.sector:
            sector_used[c.sector] = sector_used.get(c.sector, 0.0) + budget / equity
        if cash_left <= 0:
            break
    return budgets
