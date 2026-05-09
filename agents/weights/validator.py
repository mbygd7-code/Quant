"""Strict, raises-on-failure validator for user-submitted weights.

Three layers of defence:

  1. ``WeightsBundle`` Pydantic model in :mod:`agents.db.models` checks
     per-agent ranges at construction time.
  2. This validator additionally enforces the sum-equals-1 invariant
     and produces a ``WeightConstraintError`` with field-level detail.
  3. Postgres CHECK constraints in migration 20 catch any insert that
     somehow bypassed (1) and (2).

Use :func:`validate_user_weights` in API handlers (e.g. PUT
/api/agents/weights) before persisting.
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from pydantic import ValidationError

from agents.db.models import VotingAgent, WeightsBundle
from agents.weights.constants import (
    AGENT_NAMES,
    MAX_WEIGHT,
    MIN_WEIGHT,
    SUM_TARGET,
    SUM_TOLERANCE,
    TALEB_MIN,
)


@dataclass(frozen=True)
class WeightConstraintError(ValueError):
    """Raised when user-submitted weights violate a rule.

    Carries enough structure for an API handler to produce a 400 with
    a per-field message::

        try:
            validate_user_weights(payload)
        except WeightConstraintError as exc:
            return JSONResponse(
                {"error": exc.message, "field": exc.field, "value": str(exc.value)},
                status_code=400,
            )
    """

    field: str
    message: str
    value: Any = None

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.field}: {self.message}"


def _agent_bounds(agent: VotingAgent) -> tuple[Decimal, Decimal]:
    if agent == "taleb":
        return TALEB_MIN, MAX_WEIGHT
    return MIN_WEIGHT, MAX_WEIGHT


def validate_user_weights(payload: dict[str, Any] | WeightsBundle) -> WeightsBundle:
    """Coerce + validate. Returns a clean :class:`WeightsBundle`.

    Raises :class:`WeightConstraintError` with the offending field on
    any rule violation. Never raises Pydantic's ``ValidationError`` —
    we always translate so callers have a single exception type.
    """
    # Step 1: type coercion via Pydantic. This catches per-agent range
    # violations (5%-40% / Taleb 10%) and missing/extra keys.
    try:
        if isinstance(payload, WeightsBundle):
            bundle = payload
        else:
            bundle = WeightsBundle.model_validate(payload)
    except ValidationError as exc:
        # Pick the first error and surface it. Pydantic v2 errors have
        # ``loc`` (tuple) + ``msg`` + ``input``.
        first = exc.errors()[0]
        loc = first.get("loc") or ("<root>",)
        field = ".".join(str(p) for p in loc) if loc else "<root>"
        raise WeightConstraintError(
            field=field,
            message=str(first.get("msg", "invalid")),
            value=first.get("input"),
        ) from exc

    # Step 2: every required agent present (Pydantic enforces, but
    # double-check in case the payload was a dict that smuggled extras
    # in via subclass attributes — unlikely, but cheap).
    weights = bundle.model_dump()
    for agent in AGENT_NAMES:
        if agent not in weights:
            raise WeightConstraintError(field=agent, message="missing weight")

    # Step 3: per-agent bounds. Pydantic should have caught these but
    # we re-state them with a friendlier message that mentions the
    # bound that was violated, not just "Input should be ≥ 0.05".
    for agent in AGENT_NAMES:
        lo, hi = _agent_bounds(agent)
        v = Decimal(str(weights[agent]))
        if v < lo:
            raise WeightConstraintError(
                field=agent,
                message=f"weight {v} below floor {lo}",
                value=v,
            )
        if v > hi:
            raise WeightConstraintError(
                field=agent,
                message=f"weight {v} above ceiling {hi}",
                value=v,
            )

    # Step 4: sum invariant.
    total = sum((Decimal(str(weights[a])) for a in AGENT_NAMES), Decimal(0))
    drift = abs(total - SUM_TARGET)
    if drift > SUM_TOLERANCE:
        raise WeightConstraintError(
            field="<sum>",
            message=(
                f"weights must sum to {SUM_TARGET} (got {total}, "
                f"drift {drift} > tolerance {SUM_TOLERANCE}). "
                "Use normalize_weights() if you want auto-correction."
            ),
            value=total,
        )

    return bundle
