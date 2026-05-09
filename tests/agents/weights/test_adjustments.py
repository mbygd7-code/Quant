"""Soros overlay tests — multiplier application + re-normalisation."""
from __future__ import annotations

from decimal import Decimal

from agents.weights import DEFAULT_WEIGHTS, apply_soros_overlay


def _sum(bundle) -> Decimal:  # type: ignore[no-untyped-def]
    return sum((Decimal(str(v)) for v in bundle.model_dump().values()), Decimal(0))


def test_identity_overlay_is_noop() -> None:
    out = apply_soros_overlay(DEFAULT_WEIGHTS, {})
    # No multipliers given → all 1.0 → values unchanged after re-normalise.
    assert out.model_dump() == DEFAULT_WEIGHTS.model_dump()


def test_taleb_boost_resnormalises() -> None:
    # Boost taleb 1.5x — sum increases, then we rescale back to 1.0.
    out = apply_soros_overlay(DEFAULT_WEIGHTS, {"taleb": Decimal("1.5")})
    assert _sum(out) == Decimal("1.00")
    # taleb should be larger than before, others smaller in proportion.
    assert out.taleb > DEFAULT_WEIGHTS.taleb


def test_two_agents_pushed_in_opposite_directions() -> None:
    out = apply_soros_overlay(
        DEFAULT_WEIGHTS,
        {"taleb": Decimal("1.5"), "simons": Decimal("0.5")},
    )
    assert _sum(out) == Decimal("1.00")
    assert out.taleb > DEFAULT_WEIGHTS.taleb
    assert out.simons < DEFAULT_WEIGHTS.simons


def test_overlay_keeps_within_bounds() -> None:
    """Even an extreme +50% on simons (already 0.20) shouldn't push
    the final value above the 0.40 ceiling after re-normalisation."""
    out = apply_soros_overlay(DEFAULT_WEIGHTS, {"simons": Decimal("1.5")})
    for k, v in out.model_dump().items():
        floor = Decimal("0.10") if k == "taleb" else Decimal("0.05")
        assert floor <= Decimal(str(v)) <= Decimal("0.40")
