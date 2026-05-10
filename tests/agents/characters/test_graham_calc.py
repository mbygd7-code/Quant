"""Pure-function tests for Graham's calculator pipeline.

The LLM call is exercised separately in test_graham_llm.py; here we
pin the deterministic math so a future change to the constants
(PER_CAP, quality buckets, etc.) breaks loudly.
"""
from __future__ import annotations

from datetime import date as Date
from decimal import Decimal

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters._data import KrFinancialsRow, KrFundamentalsRow, KrQuoteRow
from agents.characters.graham import (
    GrahamInputs,
    combine_score,
    intrinsic_value,
    pbr_intrinsic_value,
    per_intrinsic_value,
    quality_score,
    quality_score_with_roe,
    safety_margin_pct,
    safety_margin_to_score,
)

# ─── per_intrinsic_value ────────────────────────────────────────────


def test_per_value_caps_at_15x() -> None:
    """Growth above 3.25% saturates at PER_CAP = 15."""
    v = per_intrinsic_value(eps=Decimal("1000"), growth_rate=Decimal("0.10"))
    assert v == Decimal("15000.00")


def test_per_value_low_growth_uses_formula() -> None:
    """Growth 0% → fair_per = 8.5 → eps × 8.5."""
    v = per_intrinsic_value(eps=Decimal("1000"), growth_rate=Decimal("0"))
    assert v == Decimal("8500.00")


def test_per_value_negative_growth_clamped() -> None:
    """Growth -50% clamps to -20% then floors at PER_FLOOR=3.0.

    Without the floor, 8.5 + 2*(-20) = -31.5 → eps × -31.5 flips the
    intrinsic value sign, which then breaks the safety_margin math
    (a negative IV would make every price look like a discount).
    The floor caps the downside at "deep distressed" 3.0× EPS.
    """
    v = per_intrinsic_value(eps=Decimal("1000"), growth_rate=Decimal("-0.50"))
    # growth_pct = -20 → raw fair_per = -31.5 → floored at 3.0 → 1000 × 3.0
    assert v == Decimal("3000.00")


# ─── pbr_intrinsic_value ───────────────────────────────────────────


def test_pbr_value_high_roe_caps_at_2x() -> None:
    v = pbr_intrinsic_value(bps=Decimal("10000"), roe=Decimal("0.30"))
    assert v == Decimal("20000.00")


def test_pbr_value_mid_roe_scales() -> None:
    # roe = 0.10 → multiplier = 1.0 → bps × 1.0
    v = pbr_intrinsic_value(bps=Decimal("10000"), roe=Decimal("0.10"))
    assert v == Decimal("10000.00")


def test_pbr_value_zero_roe_returns_zero() -> None:
    v = pbr_intrinsic_value(bps=Decimal("10000"), roe=Decimal("0"))
    assert v == Decimal("0")


# ─── safety_margin ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("intrinsic", "current", "expected"),
    [
        ("100", "75", "0.2500"),     # 25% margin
        ("100", "100", "0"),          # at fair value
        ("100", "150", "-0.5000"),   # 50% premium
    ],
)
def test_safety_margin_calculation(
    intrinsic: str, current: str, expected: str
) -> None:
    margin = safety_margin_pct(Decimal(intrinsic), Decimal(current))
    assert margin == Decimal(expected)


@pytest.mark.parametrize(
    ("margin", "expected_score"),
    [
        ("0.30", "1.5"),      # > +25%
        ("0.15", "0.7"),      # +10..25%
        ("0", "0"),            # neutral
        ("-0.15", "-0.7"),    # -10..-25%
        ("-0.30", "-1.5"),    # < -25%
    ],
)
def test_safety_margin_to_score(margin: str, expected_score: str) -> None:
    out = safety_margin_to_score(Decimal(margin))
    assert out == Decimal(expected_score)


# ─── combine_score ──────────────────────────────────────────────────


def test_combine_score_quality_amplifies() -> None:
    """quality=100 boosts safety_score by 50%."""
    out = combine_score(Decimal("1.0"), 100)
    assert out == Decimal("1.50")


def test_combine_score_quality_zero_no_boost() -> None:
    out = combine_score(Decimal("1.0"), 0)
    assert out == Decimal("1.00")


def test_combine_score_clamped_at_two() -> None:
    """Even quality=100 can't push above +2.00."""
    out = combine_score(Decimal("1.5"), 100)
    assert out == Decimal("2.00")
    out_neg = combine_score(Decimal("-1.5"), 100)
    assert out_neg == Decimal("-2.00")


# ─── quality_score ──────────────────────────────────────────────────


def _financials(
    op_yoys: list[float | None],
    rev_yoys: list[float | None],
    net_incomes: list[int | None] | None = None,
) -> list[KrFinancialsRow]:
    """Build N most-recent quarters from parallel lists."""
    rows = []
    fy = 2026
    for i, (op, rev) in enumerate(zip(op_yoys, rev_yoys)):
        rows.append(
            KrFinancialsRow(
                ticker="005930",
                fiscal_year=fy - i // 4,
                reprt_code="11013",
                period_end=Date(fy - i // 4, 3, 31),
                revenue=1_000_000_000,
                operating_income=100_000_000,
                net_income=(net_incomes[i] if net_incomes else 50_000_000),
                revenue_yoy=rev,
                op_income_yoy=op,
                net_income_yoy=None,
            )
        )
    return rows


def test_quality_score_strong_growth() -> None:
    """All five quarters positive, recent revenue improving."""
    rows = _financials(
        op_yoys=[0.20, 0.18, 0.15, 0.12, 0.10],
        rev_yoys=[0.15, 0.12, 0.10, 0.08, 0.06],
    )
    score = quality_score(rows)
    # 5 positive op = +25, recent_rev (0.15) > avg (0.102) = improving +20,
    # 5 positive net = +25 → 70
    assert score == 70


def test_quality_score_weak_business() -> None:
    rows = _financials(
        op_yoys=[-0.10, -0.05, 0.02, -0.03, -0.08],
        rev_yoys=[-0.10, -0.08, -0.05, -0.03, 0],
        net_incomes=[-100_000, 50_000, -200_000, 30_000, -10_000],
    )
    score = quality_score(rows)
    assert 0 <= score <= 30


def test_quality_score_empty() -> None:
    assert quality_score([]) == 0


def test_quality_with_roe_high_bonus() -> None:
    rows = _financials(
        op_yoys=[0.10, 0.10, 0.10, 0.10, 0.10],
        rev_yoys=[0.05, 0.05, 0.05, 0.05, 0.05],
    )
    base = quality_score(rows)
    boosted = quality_score_with_roe(rows, roe_now=0.20)
    assert boosted == min(100, base + 25)


def test_quality_with_roe_no_data_returns_base() -> None:
    rows = _financials(
        op_yoys=[0.10, 0.10, 0.10, 0.10, 0.10],
        rev_yoys=[0.05, 0.05, 0.05, 0.05, 0.05],
    )
    assert quality_score_with_roe(rows, roe_now=None) == quality_score(rows)


# ─── intrinsic_value end-to-end ─────────────────────────────────────


def _bundle(
    *,
    pe: float | None = 12.0,
    pbr: float | None = 1.2,
    roe: float | None = 0.15,
    close: int = 60_000,
    rev_yoys: list[float | None] | None = None,
) -> GrahamInputs:
    return GrahamInputs(
        fundamentals=KrFundamentalsRow(
            date=Date(2026, 5, 9),
            ticker="005930",
            forward_pe=pe,
            trailing_pe=pe,
            price_to_book=pbr,
            roe=roe,
            market_cap=400_000_000_000_000,
        ),
        financials=_financials(
            op_yoys=[0.10, 0.08, 0.06, 0.04, 0.02],
            rev_yoys=rev_yoys
            if rev_yoys is not None
            else [0.08, 0.07, 0.06, 0.05, 0.04],
        ),
        quotes=[
            KrQuoteRow(
                date=Date(2026, 5, 9),
                ticker="005930",
                open=close - 200,
                high=close + 300,
                low=close - 400,
                close=close,
                volume=10_000_000,
                trading_value=600_000_000_000,
                foreign_net_buy=0,
                change_rate=0.0,
            ),
        ],
    )


def test_intrinsic_both_methods_picks_minimum() -> None:
    b = _bundle()
    iv = intrinsic_value(
        fundamentals=b.fundamentals,
        financials=b.financials,
        current_price=Decimal(str(b.quotes[0].close)),
    )
    assert iv.per_method is not None
    assert iv.pbr_method is not None
    assert iv.conservative == min(iv.per_method, iv.pbr_method)
    assert iv.method_used == "min(PER,PBR)"


def test_intrinsic_pbr_only_when_pe_missing() -> None:
    b = _bundle(pe=None)
    iv = intrinsic_value(
        fundamentals=b.fundamentals,
        financials=b.financials,
        current_price=Decimal(str(b.quotes[0].close)),
    )
    assert iv.per_method is None
    assert iv.pbr_method is not None
    assert iv.conservative == iv.pbr_method
    assert iv.method_used == "PBR only"


def test_intrinsic_per_only_when_pbr_missing() -> None:
    b = _bundle(pbr=None)
    iv = intrinsic_value(
        fundamentals=b.fundamentals,
        financials=b.financials,
        current_price=Decimal(str(b.quotes[0].close)),
    )
    assert iv.per_method is not None
    assert iv.pbr_method is None
    assert iv.method_used == "PER only"


def test_intrinsic_none_when_both_missing() -> None:
    b = _bundle(pe=None, pbr=None)
    iv = intrinsic_value(
        fundamentals=b.fundamentals,
        financials=b.financials,
        current_price=Decimal(str(b.quotes[0].close)),
    )
    assert iv.conservative is None
    assert iv.method_used == "none"


# ─── analyze() with mocked LLM ──────────────────────────────────────


def test_analyze_raises_insufficient_when_no_intrinsic_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agents.characters.graham import Graham

    b = _bundle(pe=None, pbr=None)
    g = Graham()
    with pytest.raises(InsufficientDataError):
        g.analyze("005930", _now(), inputs=b)


def test_analyze_returns_row_with_score_and_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agents.characters import graham as graham_mod
    from agents.characters.graham import Graham
    from agents.llm.client import ClaudeResult

    fake_result = ClaudeResult(
        text='{"narrative":"본질가치 대비 안전마진이 충분히 확보된 수준입니다."}',
        model="claude-test",
        input_tokens=120,
        output_tokens=40,
        cost_estimate_usd=0.001,
    )
    fake_parsed = graham_mod.GrahamLLMResponse(
        narrative="본질가치 대비 안전마진이 충분히 확보된 수준입니다."
    )
    monkeypatch.setattr(
        graham_mod, "call_claude", lambda **kwargs: (fake_result, fake_parsed)
    )

    g = Graham()
    out = g.analyze("005930", _now(), inputs=_bundle())

    assert out.agent_name == "graham"
    assert out.ticker == "005930"
    assert -2 <= float(out.score) <= 2
    assert "안전마진" in out.narrative
    payload = out.raw_payload
    assert payload["method_used"] in ("min(PER,PBR)", "PER only", "PBR only")
    assert payload["data_window_quarters"] >= 2
    assert "current_price" in payload


def _now():
    from datetime import UTC
    from datetime import datetime as _dt

    return _dt(2026, 5, 9, 7, 0, tzinfo=UTC)


# ─── PE fallback regression (2026-05-10) ───────────────────────────


def test_intrinsic_value_falls_back_to_forward_pe_when_trailing_null() -> None:
    """Korean kr_fundamentals snapshots commonly have trailing_pe=NULL
    but forward_pe populated. Graham must use forward_pe in that case
    instead of dropping the whole voter."""
    b = _bundle(pe=None, pbr=None)
    # Manually substitute trailing_pe=None, forward_pe=10 — kr_fundamentals
    # truth shape from real DART/yfinance ingestion.
    fundamentals = KrFundamentalsRow(
        date=Date(2026, 5, 10),
        ticker="005930",
        forward_pe=10.0,
        trailing_pe=None,
        price_to_book=None,
        roe=0.18,
        market_cap=400_000_000_000_000,
    )
    iv = intrinsic_value(
        fundamentals=fundamentals,
        financials=b.financials,
        current_price=Decimal("60000"),
    )
    assert iv.per_method is not None
    assert iv.pbr_method is None  # no price_to_book → PBR drops
    assert iv.conservative == iv.per_method
    assert iv.method_used == "PER only"
