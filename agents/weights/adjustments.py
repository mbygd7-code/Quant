"""Soros' temporary ±50% weight overlay.

Per system-weight-settings.md and character-soros.md:

  * Soros can multiply any single voting agent's weight by 0.5..1.5.
  * The user's stored ``user_weight_settings.weights`` is NOT modified.
  * Overlays are additive layers applied at signal-generation time
    (Q1 of Soros' workflow).

This module exposes ``apply_soros_overlay`` so the M2 Soros
implementation can call it without re-deriving the math. The DB-side
storage + validation lives in migration 20 + the trigger
``soros_weight_adjustments_overlay_chk``.

M1 ships the function signature only — the call site is in M2 (Soros).
A unit test verifies the math; the live cron path is wired later.
"""
from __future__ import annotations

from decimal import Decimal

from agents.db.models import VotingAgent, WeightsBundle
from agents.weights.normalizer import normalize_weights


def apply_soros_overlay(
    weights: WeightsBundle,
    overlay: dict[VotingAgent, Decimal],
) -> WeightsBundle:
    """Apply per-agent multipliers, then re-normalise to sum 1.

    ``overlay`` keys may be a *subset* of the 6 voting agents — agents
    not mentioned keep their original weight (multiplier = 1).

    All multipliers must be in [0.5, 1.5]; the
    :class:`agents.db.models.SorosWeightAdjustmentNew` Pydantic model
    enforces this at construction time, so by the time we get here
    the bounds are already trusted.

    Re-normalisation can push individual weights to their own bounds;
    we delegate to ``normalize_weights`` so the final bundle satisfies
    both sum-to-1 and per-agent ranges. If the overlay is so extreme
    no valid bundle exists, ``normalize_weights`` raises
    :class:`agents.weights.validator.WeightConstraintError`.
    """
    raw = weights.model_dump()
    overlaid: dict[str, Decimal] = {
        k: Decimal(str(v)) * Decimal(str(overlay.get(k, Decimal(1))))
        for k, v in raw.items()
    }
    return normalize_weights(overlaid)
