"""US → KR signal translation via us_kr_mapping table.

Reads:
  - us_kr_mapping(us_symbol, kr_ticker, impact_strength)  — alpha core
  - global_market(date, symbol, change_rate)              — yesterday's US move

Output: a single normalized score in (0, 1) for each KR ticker, expressing
how much US pre-market signals favor it for the next KR session.

Formula (CLAUDE.md SKILL.md §3 'related_us_stock_score'):
    weighted = Σ(change_rate × impact_strength) / Σ(impact_strength)
    score = sigmoid(weighted × SCALE)

We pick SCALE=50 so a +2% weighted US move maps to ~0.73 ('관심' band) and
+5% maps to ~0.92 ('강한 관심'). A symmetric -3% maps to ~0.18 ('주의').
"""
from __future__ import annotations

import logging
import math
from datetime import date as Date

from db.supabase_client import get_admin_client

log = logging.getLogger("cognition.mapper")

WEIGHTED_CHANGE_SCALE = 50.0
NEUTRAL_SCORE = 0.5


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


def calculate_related_us_score(
    kr_ticker: str,
    on_date: Date,
    *,
    mappings: list[dict] | None = None,
    us_changes: dict[str, float] | None = None,
) -> float:
    """Score in [0, 1] reflecting US-side support for `kr_ticker` on `on_date`.

    The optional `mappings` and `us_changes` kwargs let tests inject fixtures
    without hitting the DB. In production both are loaded from Supabase.
    """
    if mappings is None:
        mappings = _fetch_mappings(kr_ticker)
    if not mappings:
        return NEUTRAL_SCORE

    if us_changes is None:
        symbols = [m["us_symbol"] for m in mappings]
        us_changes = _fetch_us_changes(symbols, on_date)

    weighted_sum = 0.0
    impact_sum = 0.0
    for m in mappings:
        change = us_changes.get(m["us_symbol"])
        if change is None:
            continue                                    # skip mappings with no data
        impact = float(m["impact_strength"])
        weighted_sum += change * impact
        impact_sum += impact

    if impact_sum == 0.0:
        return NEUTRAL_SCORE

    weighted_mean = weighted_sum / impact_sum
    return sigmoid(weighted_mean * WEIGHTED_CHANGE_SCALE)


# ──────────────────────────────────────────────────────────
# DB lookups (separate so tests can mock or replace)
# ──────────────────────────────────────────────────────────
def _fetch_mappings(kr_ticker: str) -> list[dict]:
    sb = get_admin_client()
    rows = (
        sb.table("us_kr_mapping")
          .select("us_symbol, impact_strength")
          .eq("kr_ticker", kr_ticker)
          .execute()
          .data
    ) or []
    return rows


def _fetch_us_changes(symbols: list[str], on_date: Date) -> dict[str, float]:
    if not symbols:
        return {}
    sb = get_admin_client()
    rows = (
        sb.table("global_market")
          .select("symbol, change_rate")
          .eq("date", on_date.isoformat())
          .in_("symbol", symbols)
          .execute()
          .data
    ) or []
    return {r["symbol"]: float(r["change_rate"]) for r in rows if r.get("change_rate") is not None}
