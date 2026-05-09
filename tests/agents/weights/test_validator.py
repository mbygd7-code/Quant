"""Validator tests — strict rejection of out-of-spec weights."""
from __future__ import annotations

from decimal import Decimal

import pytest

from agents.weights import (
    DEFAULT_WEIGHTS,
    WeightConstraintError,
    validate_user_weights,
)


def _bundle(**overrides: str | Decimal) -> dict[str, str]:
    """Build a payload dict by overriding fields on DEFAULT_WEIGHTS."""
    base = {k: str(v) for k, v in DEFAULT_WEIGHTS.model_dump().items()}
    for k, v in overrides.items():
        base[k] = str(v)
    return base


def test_default_weights_pass() -> None:
    out = validate_user_weights(_bundle())
    assert out.simons == Decimal("0.20")
    assert out.taleb == Decimal("0.13")


def test_below_min_rejected() -> None:
    # Lower simons to 0.04, push the slack into graham so the sum stays
    # at 1.00. The validator should still reject because per-agent
    # range is checked before the sum.
    payload = _bundle(simons="0.04", graham="0.34")
    with pytest.raises(WeightConstraintError) as exc:
        validate_user_weights(payload)
    assert exc.value.field == "simons"


def test_above_max_rejected() -> None:
    payload = _bundle(simons="0.41", graham="-0.03")
    with pytest.raises(WeightConstraintError) as exc:
        validate_user_weights(payload)
    # Could fail on simons (too high) or graham (negative). We just
    # care that *something* failed clearly.
    assert exc.value.field in ("simons", "graham")


def test_taleb_floor_enforced() -> None:
    # Taleb at 0.05 (below 0.10 floor) — must fail even if sum is 1.0.
    payload = _bundle(taleb="0.05", graham="0.26")
    with pytest.raises(WeightConstraintError) as exc:
        validate_user_weights(payload)
    assert exc.value.field == "taleb"


def test_sum_drift_rejected() -> None:
    # All bounds OK, but sum is 0.95 — fail.
    payload = _bundle(simons="0.15")  # was 0.20, now 0.15 → sum 0.95
    with pytest.raises(WeightConstraintError) as exc:
        validate_user_weights(payload)
    assert exc.value.field == "<sum>"
    assert "sum" in exc.value.message.lower()


def test_sum_within_tolerance_accepted() -> None:
    # Pull simons by 0.0005; sum becomes 0.9995 (within tolerance 0.001).
    payload = _bundle(simons="0.1995")
    out = validate_user_weights(payload)
    assert out.simons == Decimal("0.1995")


def test_missing_field_rejected() -> None:
    # Drop taleb entirely; Pydantic catches this in step 1.
    payload = _bundle()
    payload.pop("taleb")
    with pytest.raises(WeightConstraintError) as exc:
        validate_user_weights(payload)
    assert "taleb" in exc.value.field
