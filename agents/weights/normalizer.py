"""Best-effort sum-to-1 correction.

Distinct from :mod:`agents.weights.validator`: validator *rejects*
out-of-spec input, normalizer *fixes* small drift.

Algorithm — pin-and-scale (O(n) on number of agents)
----------------------------------------------------

1. If the input is all-zero, fall back to DEFAULT_WEIGHTS.
2. Otherwise loop:
   * compute the scale factor that would make the *free* (un-pinned)
     agents sum to ``SUM_TARGET - sum(pinned)``
   * apply the scale; any agent that lands outside its [floor, ceiling]
     gets pinned to that bound (fixed for the remainder of the loop)
   * if no new pin happened this iteration, we've converged
3. Snap to two decimal places (NUMERIC(4,2) precision) and absorb any
   1-cent rounding drift into the largest weight so the sum is exactly
   1.00.

This converges in at most ``len(AGENT_NAMES) = 6`` iterations because
each iteration either pins ≥1 agent or terminates.
"""
from __future__ import annotations

from decimal import Decimal
from typing import Any

from agents.db.models import WeightsBundle
from agents.weights.constants import (
    AGENT_NAMES,
    DEFAULT_WEIGHTS,
    MAX_WEIGHT,
    MIN_WEIGHT,
    SUM_TARGET,
    SUM_TOLERANCE,
    TALEB_MIN,
)
from agents.weights.validator import WeightConstraintError


def _bounds(agent: str) -> tuple[Decimal, Decimal]:
    return (TALEB_MIN, MAX_WEIGHT) if agent == "taleb" else (MIN_WEIGHT, MAX_WEIGHT)


def _coerce_input(payload: dict[str, Any] | WeightsBundle) -> dict[str, Decimal]:
    raw = payload.model_dump() if isinstance(payload, WeightsBundle) else payload
    out: dict[str, Decimal] = {}
    for agent in AGENT_NAMES:
        if agent not in raw:
            raise WeightConstraintError(field=agent, message="missing weight")
        out[agent] = Decimal(str(raw[agent]))
    return out


def _snap_to_two_decimals(values: dict[str, Decimal]) -> dict[str, Decimal]:
    """Round each weight to two decimal places, then absorb any
    rounding drift into the largest weight so the sum is exactly 1.00."""
    snapped = {k: v.quantize(Decimal("0.01")) for k, v in values.items()}
    drift = SUM_TARGET - sum(snapped.values(), Decimal(0))
    if drift == 0:
        return snapped
    largest = max(snapped, key=lambda a: snapped[a])
    snapped[largest] += drift
    return snapped


def normalize_weights(payload: dict[str, Any] | WeightsBundle) -> WeightsBundle:
    """Iteratively pin-and-scale until sum=1 holds within tolerance.

    Raises :class:`WeightConstraintError` only in the truly degenerate
    case where every agent has been pinned (none free) and the pinned
    sum still doesn't equal :data:`SUM_TARGET`. With six agents whose
    bound ranges sum to [0.35, 2.40], any reasonable input fits.
    """
    values = _coerce_input(payload)

    # Degenerate input — every weight zero. Don't divide by zero;
    # return defaults so the user has something coherent to look at.
    if all(v == 0 for v in values.values()):
        return WeightsBundle.model_validate(DEFAULT_WEIGHTS.model_dump())

    pinned: dict[str, Decimal] = {}
    free: dict[str, Decimal] = dict(values)

    for _ in range(len(AGENT_NAMES) + 1):  # at most len(AGENT_NAMES) pins
        free_target = SUM_TARGET - sum(pinned.values(), Decimal(0))
        free_sum = sum(free.values(), Decimal(0))

        if free_sum == 0:
            # All free agents zeroed out by previous scaling; nothing
            # left to redistribute. Bail to avoid div-by-zero.
            break

        scale = free_target / free_sum
        scaled = {k: v * scale for k, v in free.items()}

        new_pinned: dict[str, Decimal] = {}
        for agent, v in scaled.items():
            lo, hi = _bounds(agent)
            if v < lo:
                new_pinned[agent] = lo
            elif v > hi:
                new_pinned[agent] = hi

        if not new_pinned:
            # Everyone in bounds → converged.
            free = scaled
            break

        for agent, v in new_pinned.items():
            pinned[agent] = v
            free.pop(agent, None)
        # Re-loop with the un-pinned agents only.

    combined = {**pinned, **free}

    # Final invariant check — on a normal path this is satisfied. The
    # only way it fails is if the user demanded a configuration where
    # the pinned bounds alone sum to something outside [SUM_TARGET ±
    # SUM_TOLERANCE], which is geometrically impossible with our
    # bounds. We still guard so a future change to bounds can't
    # silently produce an invalid bundle.
    drift = abs(sum(combined.values(), Decimal(0)) - SUM_TARGET)
    if drift > SUM_TOLERANCE * 10:  # generous since we'll re-snap
        raise WeightConstraintError(
            field="<all>",
            message=(
                "could not normalize within bounds — input violates both "
                "per-agent range and sum-to-1 in a way that has no fix"
            ),
            value=combined,
        )

    snapped = _snap_to_two_decimals(combined)
    return WeightsBundle.model_validate(snapped)
