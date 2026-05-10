"""Change-detection guard — skip a ticker's M4 analysis when nothing
has materially moved since the last cycle.

Cost optimisation, not algorithm change. The cycle still runs every
ticker that's *due*; this helper just decides which dues are no-ops.

Three thresholds — any one tripping forces a re-analysis:

  1. Price change vs previous close > ±2.0%
  2. Recent volume vs 20-day average > 1.5×
  3. Macro shock — any of {USDKRW, ^VIX, ^TNX} moved > ±1.0% intraday

When *all three* are quiet, the cycle reuses the previous cycle's
agent_outputs row (no LLM cost) and re-emits a final_signal pointing
to the same scores. The Soros weighted_score is recomputed cheaply so
weight-tuning is still reflected.

Calling convention:

    if not should_reanalyze(ticker, cycle_at, prev_quote, latest_quote, macro):
        # reuse last cycle's outputs

Defaults are tuned for KR equities. Tunable via the constants below
without touching the call sites.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from agents.characters._data import GlobalMarketRow, KrQuoteRow

#: Price move threshold — single-day return that wakes the cycle.
PRICE_THRESHOLD_PCT = Decimal("0.02")  # 2%

#: Volume ratio (latest / 20-day avg) that wakes the cycle.
VOLUME_RATIO_THRESHOLD = Decimal("1.5")

#: Macro factor move threshold — intraday change that wakes everyone.
MACRO_THRESHOLD_PCT = Decimal("0.01")  # 1%

#: Macro symbols watched for shock detection (subset of Keynes' set).
MACRO_SHOCK_SYMBOLS: tuple[str, ...] = ("USDKRW", "^VIX", "^TNX")


@dataclass(frozen=True)
class ChangeReport:
    """Returned reason flags so callers can log *why* a ticker re-ran
    (or didn't). The cycle orchestrator records the dominant reason
    in ``CycleReport.outcomes`` so a slow-news week still surfaces in
    the artifact log."""

    re_run: bool
    price_move: Decimal | None
    volume_ratio: Decimal | None
    macro_shocks: tuple[str, ...]
    reason: str  # human-readable summary


def price_change_pct(
    quotes: list[KrQuoteRow],
) -> Decimal | None:
    """Most recent close vs the previous close, as a fractional return.
    Returns ``None`` when fewer than two valid closes."""
    closes = [q.close for q in quotes if q.close is not None and q.close > 0]
    if len(closes) < 2:
        return None
    latest, prev = closes[0], closes[1]
    return Decimal(latest - prev) / Decimal(prev)


def volume_ratio_vs_20d(
    quotes: list[KrQuoteRow],
) -> Decimal | None:
    """Latest day's volume divided by the trailing 20-day average. Used
    as a proxy for "something happened that the model needs to look at
    again". Returns ``None`` when fewer than 5 days of valid volume."""
    vols = [q.volume for q in quotes if q.volume is not None and q.volume > 0]
    if len(vols) < 5:
        return None
    latest = Decimal(vols[0])
    window = vols[1 : min(21, len(vols))]
    if not window:
        return None
    avg = Decimal(sum(window)) / Decimal(len(window))
    if avg == 0:
        return None
    return latest / avg


def macro_shocks(
    macro_quotes_by_symbol: dict[str, list[GlobalMarketRow]],
) -> tuple[str, ...]:
    """Which of MACRO_SHOCK_SYMBOLS moved more than the threshold
    intraday. Empty tuple = quiet macro. The cycle re-runs every
    ticker on a macro-shock day (single shock cascades to all)."""
    shocked: list[str] = []
    for sym in MACRO_SHOCK_SYMBOLS:
        rows = macro_quotes_by_symbol.get(sym) or []
        if len(rows) < 2:
            continue
        latest = rows[0].close
        prev = rows[1].close
        if latest is None or prev is None or prev == 0:
            continue
        move = abs(Decimal(str(latest - prev))) / Decimal(str(prev))
        if move >= MACRO_THRESHOLD_PCT:
            shocked.append(sym)
    return tuple(shocked)


def should_reanalyze(
    *,
    ticker: str,  # noqa: ARG001 — kept for log readability at call sites
    quotes: list[KrQuoteRow],
    macro_quotes_by_symbol: dict[str, list[GlobalMarketRow]] | None = None,
) -> ChangeReport:
    """Returns a :class:`ChangeReport` whose ``re_run`` field is True
    when *any* of the three thresholds tripped.

    Two safety paths:
      * If we can't compute any of the three (e.g. brand-new ticker
        with one quote), default to ``re_run=True`` — better to spend
        the LLM cost than skip a real signal.
      * Macro shocks short-circuit — even a perfectly quiet ticker
        re-runs when USDKRW jumps, because Keynes' beta produces a
        different score.
    """
    pmove = price_change_pct(quotes)
    vratio = volume_ratio_vs_20d(quotes)
    shocks = macro_shocks(macro_quotes_by_symbol or {})

    # Macro shock → re-run
    if shocks:
        return ChangeReport(
            re_run=True,
            price_move=pmove,
            volume_ratio=vratio,
            macro_shocks=shocks,
            reason=f"macro shock: {','.join(shocks)}",
        )

    # No data → re-run (safety)
    if pmove is None and vratio is None:
        return ChangeReport(
            re_run=True,
            price_move=pmove,
            volume_ratio=vratio,
            macro_shocks=(),
            reason="insufficient quote history → analyse to be safe",
        )

    # Price move
    if pmove is not None and abs(pmove) >= PRICE_THRESHOLD_PCT:
        return ChangeReport(
            re_run=True,
            price_move=pmove,
            volume_ratio=vratio,
            macro_shocks=(),
            reason=f"price move {float(pmove) * 100:+.2f}%",
        )

    # Volume spike
    if vratio is not None and vratio >= VOLUME_RATIO_THRESHOLD:
        return ChangeReport(
            re_run=True,
            price_move=pmove,
            volume_ratio=vratio,
            macro_shocks=(),
            reason=f"volume {float(vratio):.2f}× 20d avg",
        )

    # Quiet on all axes
    return ChangeReport(
        re_run=False,
        price_move=pmove,
        volume_ratio=vratio,
        macro_shocks=(),
        reason=(
            f"quiet (price {float(pmove or 0) * 100:+.2f}%, "
            f"vol {float(vratio or 0):.2f}×, macro flat)"
        ),
    )
