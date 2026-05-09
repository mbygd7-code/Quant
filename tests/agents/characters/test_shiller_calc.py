"""Pure-function tests for Shiller's market regime + per-ticker math."""
from __future__ import annotations

from datetime import date as Date
from datetime import timedelta
from decimal import Decimal

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters._data import (
    GlobalMarketRow,
    KrFundamentalsRow,
    KrQuoteRow,
)
from agents.characters.shiller import (
    REGIME_BANDS,
    MarketRegimeInputs,
    assess_market_regime,
    breadth_score,
    foreign_score,
    momentum_score,
    pe_modifier,
    per_ticker_score,
    valuation_score,
    volatility_score,
)

# ─── helpers ────────────────────────────────────────────────────────


def _kospi(closes: list[float]) -> list[GlobalMarketRow]:
    today = Date(2026, 5, 9)
    return [
        GlobalMarketRow(
            date=today - timedelta(days=i),
            symbol="^KS11",
            close=c,
            change_rate=0.0,
        )
        for i, c in enumerate(closes)
    ]


def _vix(closes: list[float]) -> list[GlobalMarketRow]:
    today = Date(2026, 5, 9)
    return [
        GlobalMarketRow(
            date=today - timedelta(days=i),
            symbol="^VIX",
            close=c,
            change_rate=0.0,
        )
        for i, c in enumerate(closes)
    ]


def _funds(pes: list[float]) -> list[KrFundamentalsRow]:
    return [
        KrFundamentalsRow(
            date=Date(2026, 5, 9),
            ticker=f"00000{i}"[-6:],
            forward_pe=p,
            trailing_pe=p,
            price_to_book=1.0,
            roe=0.10,
            market_cap=1_000_000_000,
        )
        for i, p in enumerate(pes)
    ]


def _quotes(closes: list[int], foreign_5d: int = 0) -> list[KrQuoteRow]:
    today = Date(2026, 5, 9)
    out: list[KrQuoteRow] = []
    for i, c in enumerate(closes):
        out.append(
            KrQuoteRow(
                date=today - timedelta(days=i),
                ticker="x",
                open=c,
                high=c,
                low=c,
                close=c,
                volume=1_000_000,
                trading_value=c * 1_000_000,
                foreign_net_buy=(foreign_5d // 5 if i < 5 else 0),
                change_rate=0.0,
            )
        )
    return out


# ─── momentum_score ─────────────────────────────────────────────────


def test_momentum_at_top_of_range_is_high() -> None:
    """Newest close is the highest in the trailing 252-day distribution.

    ``_kospi`` writes element 0 as 'today', so a list whose first
    element is the highest value puts today at the top.
    Percentile = 99.6 (249 of 250 values strictly below) — close
    enough to the top to land in the greedy band.
    """
    series = _kospi([3000.0] + [round(2000 + i * 2, 2) for i in range(249)])
    out = momentum_score(series)
    assert out >= 95.0


def test_momentum_at_bottom_of_range_is_low() -> None:
    """Newest close (1000) below the entire prior history (2000..2498)."""
    series = _kospi([1000.0] + [round(2000 + i * 2, 2) for i in range(249)])
    out = momentum_score(series)
    assert out <= 5.0


def test_momentum_raises_on_short_window() -> None:
    series = _kospi([2000.0] * 100)
    with pytest.raises(InsufficientDataError):
        momentum_score(series)


# ─── volatility_score ───────────────────────────────────────────────


def test_volatility_low_vix_is_greedy() -> None:
    series = _vix([10.0] * 20)
    assert volatility_score(series) == 100.0


def test_volatility_high_vix_is_fearful() -> None:
    series = _vix([35.0] * 20)
    assert volatility_score(series) == 0.0


def test_volatility_mid_vix_linear_interpolation() -> None:
    # Halfway between 12 and 30 = 21 → score 50.
    series = _vix([21.0] * 20)
    assert volatility_score(series) == pytest.approx(50.0, abs=0.01)


def test_volatility_no_vix_returns_neutral() -> None:
    assert volatility_score([]) == 50.0


# ─── valuation_score ────────────────────────────────────────────────


def test_valuation_with_few_names_is_neutral() -> None:
    """< 5 names → return 50 to avoid spurious percentile."""
    funds = _funds([10.0, 12.0])
    assert valuation_score(funds) == 50.0


def test_valuation_high_pe_at_top_of_distribution() -> None:
    """All same PE → median = each value → percentile 0 (no values
    strictly *below* the median)."""
    funds = _funds([15.0] * 10)
    assert valuation_score(funds) == 0.0


def test_valuation_with_outlier_high_median() -> None:
    """Median 30 in a range 10..30 → 50% of values strictly below =
    50th percentile."""
    funds = _funds([10, 20, 30, 30, 30, 30, 30])  # median = 30
    out = valuation_score(funds)
    assert 25.0 <= out <= 35.0


# ─── foreign_score ─────────────────────────────────────────────────


def test_foreign_neutral_when_zero() -> None:
    quotes_by_t = {"x": _quotes([100] * 5, foreign_5d=0)}
    assert foreign_score(quotes_by_t) == 50.0


def test_foreign_strong_buy_saturates_to_100() -> None:
    """5T cumulative across the watchlist → saturate at 100."""
    quotes_by_t = {
        f"t{i}": _quotes([100] * 5, foreign_5d=1_000_000_000_000)
        for i in range(5)
    }
    assert foreign_score(quotes_by_t) == 100.0


def test_foreign_strong_sell_saturates_to_0() -> None:
    quotes_by_t = {
        f"t{i}": _quotes([100] * 5, foreign_5d=-1_000_000_000_000)
        for i in range(5)
    }
    assert foreign_score(quotes_by_t) == 0.0


# ─── breadth_score ──────────────────────────────────────────────────


def test_breadth_all_above_ma60_is_100() -> None:
    """Newest close higher than the 60-day mean — sticks ABOVE MA60."""
    closes = list(reversed(range(100, 160)))  # newest=159, ma60=129.5
    quotes_by_t = {"x": _quotes(closes)}
    assert breadth_score(quotes_by_t) == 100.0


def test_breadth_all_below_ma60_is_0() -> None:
    """Newest close lower than the 60-day mean — sticks BELOW MA60."""
    closes = list(range(100, 160))  # newest=100, ma60=129.5 → below
    quotes_by_t = {"x": _quotes(closes)}
    assert breadth_score(quotes_by_t) == 0.0


def test_breadth_short_window_skips_ticker() -> None:
    """A ticker with < 60 quotes is excluded; remaining names dictate
    the result."""
    quotes_by_t = {
        "short": _quotes([100] * 30),
        "long_below": _quotes(list(range(50, 110))),  # newest=50, ma60=79.5 → below
    }
    assert breadth_score(quotes_by_t) == 0.0


def test_breadth_no_eligible_tickers_returns_neutral() -> None:
    quotes_by_t = {"x": _quotes([100] * 20)}
    assert breadth_score(quotes_by_t) == 50.0


# ─── assess_market_regime ──────────────────────────────────────────


def _regime_inputs(
    *, kospi_at_top: bool = True, vix: float = 20.0, pes: list[float] | None = None
) -> MarketRegimeInputs:
    series = (
        _kospi([2000.0] + [round(1500 + i * 2, 2) for i in range(249)])
        if kospi_at_top
        else _kospi([1000.0] + [round(2000 + i * 2, 2) for i in range(249)])
    )
    return MarketRegimeInputs(
        kospi=series,
        vix=_vix([vix] * 20),
        watchlist_fundamentals=_funds(pes or [12.0, 14.0, 16.0, 18.0, 20.0]),
        watchlist_recent_quotes={
            "t1": _quotes(list(reversed(range(80, 140)))),  # all up
        },
    )


def test_regime_extreme_greed_at_top_with_low_vix() -> None:
    """Top of momentum + low VIX should land in the Mania band."""
    out = assess_market_regime(_regime_inputs(kospi_at_top=True, vix=10.0))
    assert out.market_score in (Decimal("-1.0"), Decimal("-2.0"))
    assert out.fear_greed_index >= 60
    assert "탐욕" in out.stage_label or "과열" in out.stage_label


def test_regime_capitulation_at_bottom_with_high_vix() -> None:
    out = assess_market_regime(_regime_inputs(kospi_at_top=False, vix=35.0))
    assert out.market_score in (Decimal("1.0"), Decimal("2.0"))
    assert out.fear_greed_index <= 40
    assert "공포" in out.stage_label or "회복" in out.stage_label


def test_regime_bands_complete() -> None:
    """Every band tuple has the expected shape."""
    seen_scores = set()
    for upper, label, score in REGIME_BANDS:
        assert isinstance(upper, int)
        assert isinstance(label, str)
        assert isinstance(score, Decimal)
        seen_scores.add(score)
    # +2, +1, 0, -1, -2 all present.
    assert seen_scores == {
        Decimal("2.0"),
        Decimal("1.0"),
        Decimal("0"),
        Decimal("-1.0"),
        Decimal("-2.0"),
    }


# ─── pe_modifier + per_ticker_score ────────────────────────────────


def test_pe_modifier_low_returns_positive() -> None:
    """ticker PE 8 is below median 15 → +0.30 modifier."""
    assert pe_modifier(8.0, [10.0, 12.0, 15.0, 18.0, 20.0]) == Decimal("0.30")


def test_pe_modifier_high_returns_negative() -> None:
    assert pe_modifier(25.0, [10.0, 12.0, 15.0, 18.0, 20.0]) == Decimal("-0.30")


def test_pe_modifier_neutral_band() -> None:
    """ticker PE within ±10% of median → 0."""
    assert pe_modifier(15.0, [10.0, 12.0, 15.0, 18.0, 20.0]) == Decimal("0")
    assert pe_modifier(16.0, [10.0, 12.0, 15.0, 18.0, 20.0]) == Decimal("0")


def test_pe_modifier_no_data_returns_zero() -> None:
    assert pe_modifier(None, [10.0, 12.0, 15.0]) == Decimal("0")
    assert pe_modifier(15.0, []) == Decimal("0")


@pytest.mark.parametrize(
    ("market", "pe_mod", "expected"),
    [
        (Decimal("2.0"), Decimal("0.30"), "1.70"),     # 2.0×0.7 + 0.30
        (Decimal("-2.0"), Decimal("-0.30"), "-1.70"),
        (Decimal("0"), Decimal("0"), "0"),
        (Decimal("2.0"), Decimal("0"), "1.40"),
    ],
)
def test_per_ticker_score_matrix(
    market: Decimal, pe_mod: Decimal, expected: str
) -> None:
    out = per_ticker_score(market, pe_mod)
    assert out == Decimal(expected)


def test_per_ticker_score_clamped_to_two() -> None:
    """Even at maximum market + bonus, the output sits in [-2, +2]."""
    out = per_ticker_score(Decimal("2.0"), Decimal("1.5"))
    assert out == Decimal("2.00")
