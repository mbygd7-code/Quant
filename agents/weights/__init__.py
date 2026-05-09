"""Weight system for the 6 voting agents.

Public surface::

    from agents.weights import (
        AGENT_NAMES, DEFAULT_WEIGHTS, MIN_WEIGHT, MAX_WEIGHT, TALEB_MIN,
        WeightConstraintError,
        validate_user_weights,
        normalize_weights,
        apply_soros_overlay,
    )

The pieces:

  * ``constants``    — central source of truth for the bounds.
  * ``validator``    — strict checks (raises on violation).
  * ``normalizer``   — best-effort sum-to-1 correction.
  * ``adjustments``  — Soros' temporary ±50% overlay (M1: function
                       signature only; cron call site lands in M2).

The DB-level CHECK constraints in migration 20 cover per-agent ranges
(5%-40%, Taleb floor 10%). The sum-equals-1 invariant lives here
because Postgres can't easily express it inside a CHECK.
"""
from agents.weights.adjustments import apply_soros_overlay
from agents.weights.constants import (
    AGENT_NAMES,
    DEFAULT_WEIGHTS,
    MAX_WEIGHT,
    MIN_WEIGHT,
    SUM_TARGET,
    SUM_TOLERANCE,
    TALEB_MIN,
)
from agents.weights.normalizer import normalize_weights
from agents.weights.validator import WeightConstraintError, validate_user_weights

__all__ = [
    "AGENT_NAMES",
    "DEFAULT_WEIGHTS",
    "MAX_WEIGHT",
    "MIN_WEIGHT",
    "SUM_TARGET",
    "SUM_TOLERANCE",
    "TALEB_MIN",
    "WeightConstraintError",
    "apply_soros_overlay",
    "normalize_weights",
    "validate_user_weights",
]
