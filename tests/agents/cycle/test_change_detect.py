"""Tests for the change-detection guard used by run_m4_cycle when
``--require-change`` is set.

Pure-function pins for the three threshold paths plus the safety
defaults. No DB / LLM."""
from __future__ import annotations

from datetime import date as Date
from decimal import Decimal

import pytest

from agents.characters._data import GlobalMarketRow, KrQuoteRow
from agents.cycle._change_detect import (
    MACRO_THRESHOLD_PCT,
    PRICE_THRESHOLD_PCT,
    VOLUME_RATIO_THRESHOLD,
    macro_shocks,
    price_change_pct,
    should_reanalyze,
    volume_ratio_vs_20d,
)


def _quote(close: int, vol: int = 1_000_000) -> KrQuoteRow:
    return KrQuoteRow(
        date=Date(2026, 5, 9),
        ticker="005930",
        open=close,
        high=close,
        low=close,
        close=close,
        volume=vol,
        trading_value=close * vol,
        foreign_net_buy=0,
        change_rate=0.0,
    )


def _global(close: float) -> GlobalMarketRow:
    return GlobalMarketRow(
        date=Date(2026, 5, 9), symbol="USDKRW", close=close, change_rate=None
    )


# ─── price_change_pct ───────────────────────────────────────────────


def test_price_change_pct_returns_none_with_one_quote() -> None:
    assert price_change_pct([_quote(60_000)]) is None


def test_price_change_pct_handles_basic_move() -> None:
    quotes = [_quote(61_200), _quote(60_000)]  # +2.0% intraday
    pct = price_change_pct(quotes)
    assert pct is not None
    assert abs(pct - Decimal("0.02")) < Decimal("0.0001")


# ─── volume_ratio_vs_20d ────────────────────────────────────────────


def test_volume_ratio_returns_none_when_too_thin() -> None:
    quotes = [_quote(60_000, vol=1_000_000) for _ in range(3)]
    assert volume_ratio_vs_20d(quotes) is None


def test_volume_ratio_detects_2x_spike() -> None:
    quotes = [_quote(60_000, vol=2_000_000)] + [
        _quote(60_000, vol=1_000_000) for _ in range(20)
    ]
    ratio = volume_ratio_vs_20d(quotes)
    assert ratio is not None
    assert abs(ratio - Decimal("2.0")) < Decimal("0.001")


# ─── macro_shocks ───────────────────────────────────────────────────


def test_macro_shocks_empty_when_quiet() -> None:
    macro = {
        "USDKRW": [_global(1300.0), _global(1300.5)],   # +0.04%, quiet
        "^VIX": [_global(15.0), _global(15.05)],         # ~0.3%, quiet
        "^TNX": [_global(45.0), _global(45.1)],          # ~0.2%, quiet
    }
    assert macro_shocks(macro) == ()


def test_macro_shocks_detects_usdkrw_jump() -> None:
    macro = {
        "USDKRW": [_global(1320.0), _global(1300.0)],   # +1.5%, shock
        "^VIX": [_global(15.0), _global(15.0)],
        "^TNX": [_global(45.0), _global(45.0)],
    }
    assert "USDKRW" in macro_shocks(macro)


# ─── should_reanalyze ──────────────────────────────────────────────


def test_re_run_when_quotes_too_thin() -> None:
    """Safety: not enough data → analyse anyway (don't lose a real signal)."""
    rep = should_reanalyze(
        ticker="005930", quotes=[_quote(60_000)], macro_quotes_by_symbol={}
    )
    assert rep.re_run is True
    assert "insufficient" in rep.reason


def test_skip_when_quiet_on_all_axes() -> None:
    quotes = [_quote(60_000, vol=1_000_000)] + [
        _quote(60_100, vol=1_000_000) for _ in range(21)
    ]
    rep = should_reanalyze(
        ticker="005930",
        quotes=quotes,
        macro_quotes_by_symbol={
            "USDKRW": [_global(1300.0), _global(1300.5)],
            "^VIX": [_global(15.0), _global(15.0)],
            "^TNX": [_global(45.0), _global(45.0)],
        },
    )
    assert rep.re_run is False
    assert "quiet" in rep.reason


def test_re_run_on_price_move() -> None:
    quotes = [_quote(63_000), _quote(60_000)] + [
        _quote(60_000) for _ in range(20)
    ]
    rep = should_reanalyze(
        ticker="005930", quotes=quotes, macro_quotes_by_symbol={}
    )
    assert rep.re_run is True
    assert "price move" in rep.reason


def test_re_run_on_volume_spike() -> None:
    quotes = [_quote(60_000, vol=3_000_000)] + [
        _quote(60_000, vol=1_000_000) for _ in range(20)
    ]
    rep = should_reanalyze(
        ticker="005930", quotes=quotes, macro_quotes_by_symbol={}
    )
    assert rep.re_run is True
    assert "volume" in rep.reason


def test_macro_shock_overrides_quiet_ticker() -> None:
    """A perfectly flat ticker still re-runs when USDKRW jumps."""
    quotes = [_quote(60_000)] + [_quote(60_000) for _ in range(20)]
    rep = should_reanalyze(
        ticker="005930",
        quotes=quotes,
        macro_quotes_by_symbol={
            "USDKRW": [_global(1320.0), _global(1300.0)],   # +1.5% shock
        },
    )
    assert rep.re_run is True
    assert "macro shock" in rep.reason


# ─── thresholds are exposed for tuning ─────────────────────────────


def test_constants_are_decimals() -> None:
    assert isinstance(PRICE_THRESHOLD_PCT, Decimal)
    assert isinstance(VOLUME_RATIO_THRESHOLD, Decimal)
    assert isinstance(MACRO_THRESHOLD_PCT, Decimal)


@pytest.mark.parametrize(
    ("price_pct", "expected_re_run"),
    [
        ("0.005", False),    # 0.5% — below threshold
        ("0.025", True),     # 2.5% — above threshold
        ("-0.022", True),    # -2.2% — above threshold (abs)
    ],
)
def test_price_threshold_boundary(
    price_pct: str, expected_re_run: bool
) -> None:
    pct = Decimal(price_pct)
    base = 60_000
    new_close = int(base * (1 + float(pct)))
    quotes = [_quote(new_close, vol=1_000_000)] + [
        _quote(base, vol=1_000_000) for _ in range(21)
    ]
    rep = should_reanalyze(
        ticker="005930",
        quotes=quotes,
        macro_quotes_by_symbol={
            "USDKRW": [_global(1300.0), _global(1300.0)],
        },
    )
    assert rep.re_run is expected_re_run
