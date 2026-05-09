"""Source of truth for the 6-agent weight bounds.

Ordering matters in :data:`AGENT_NAMES` — UI sliders render in this
order, so changing it causes a visual reshuffle. ``Decimal`` is used
throughout so percentages round-trip with NUMERIC(4,2) without float
drift.
"""
from __future__ import annotations

from decimal import Decimal

from agents.db.models import VotingAgent, WeightsBundle

#: The 6 voting agents in the order shown in UI sliders.
AGENT_NAMES: tuple[VotingAgent, ...] = (
    "simons",
    "graham",
    "dow",
    "shiller",
    "keynes",
    "taleb",
)

#: Per-agent floor (most agents, Taleb has its own floor).
MIN_WEIGHT: Decimal = Decimal("0.05")

#: Per-agent ceiling.
MAX_WEIGHT: Decimal = Decimal("0.40")

#: Taleb has a 10% floor — see character-taleb.md and
#: system-weight-settings.md.
TALEB_MIN: Decimal = Decimal("0.10")

#: Required sum of all agent weights.
SUM_TARGET: Decimal = Decimal("1.00")

#: How far from :data:`SUM_TARGET` we tolerate before a hard error
#: (UI float arithmetic + rounding can leave a tiny drift).
SUM_TOLERANCE: Decimal = Decimal("0.001")

#: Default weights from system-implementation-roadmap.md §2 / M1.
#: Sum = 1.00 exactly. Returned by ``GET /api/agents/weights`` for
#: users with no row yet in ``user_weight_settings``.
DEFAULT_WEIGHTS: WeightsBundle = WeightsBundle(
    simons=Decimal("0.20"),
    graham=Decimal("0.18"),
    dow=Decimal("0.18"),
    shiller=Decimal("0.13"),
    keynes=Decimal("0.18"),
    taleb=Decimal("0.13"),
)
