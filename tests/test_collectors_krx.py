"""KrxCollector — yfinance primary + pykrx fallback + supply/demand."""
from __future__ import annotations

from datetime import date as Date
from unittest.mock import patch

import pandas as pd
import pytest
from pydantic import ValidationError

from collectors.__schemas__.korea import KoreaQuote, KoreaSupplyDemand
from collectors.krx import KrxCollector

WATCHLIST_2 = [
    {"ticker": "005930", "market": "KOSPI"},
    {"ticker": "000660", "market": "KOSPI"},
]
WATCHLIST_KOSDAQ = [
    {"ticker": "058470", "market": "KOSDAQ"},
]


def _ohlcv_pykrx_row(open_=70000, high=71000, low=69500, close=70500,
                      volume=1_000_000, value=70_000_000_000, change=0.0071):
    return {"시가": open_, "고가": high, "저가": low, "종가": close,
            "거래량": volume, "거래대금": value, "등락률": change * 100}


def _ohlcv_pykrx_df(rows: dict[str, dict]) -> pd.DataFrame:
    return pd.DataFrame.from_dict(rows, orient="index")


def _yf_df(ticker_to_close: dict[str, list[float]]) -> pd.DataFrame:
    """Build a yfinance-style DataFrame.

    `ticker_to_close[symbol]` is the list of closes spanning ~10 days. The
    LAST element is treated as `target` day; the second-last is prev_close.
    Builds a multi-symbol MultiIndex frame (matches `group_by='ticker'`).
    """
    dates = pd.date_range(end="2026-05-01", periods=10, freq="D")
    if len(ticker_to_close) == 1:
        # Single-symbol: yfinance returns flat columns.
        sym, closes = next(iter(ticker_to_close.items()))
        # Pad / trim to 10 entries
        closes = closes[-10:]
        while len(closes) < 10:
            closes.insert(0, closes[0])
        return pd.DataFrame({
            "Open":   [c * 0.99 for c in closes],
            "High":   [c * 1.01 for c in closes],
            "Low":    [c * 0.98 for c in closes],
            "Close":  closes,
            "Volume": [1_000_000] * 10,
        }, index=dates)
    # Multi-symbol → MultiIndex (ticker, field)
    pieces = {}
    for sym, closes in ticker_to_close.items():
        closes = closes[-10:]
        while len(closes) < 10:
            closes.insert(0, closes[0])
        pieces[sym] = pd.DataFrame({
            "Open":   [c * 0.99 for c in closes],
            "High":   [c * 1.01 for c in closes],
            "Low":    [c * 0.98 for c in closes],
            "Close":  closes,
            "Volume": [1_000_000] * 10,
        }, index=dates)
    return pd.concat(pieces, axis=1)


# ───────────────────────────────────────────────────────────
# Pydantic model validation (unchanged)
# ───────────────────────────────────────────────────────────
class TestKoreaQuoteValidation:
    def test_valid(self):
        q = KoreaQuote(date=Date(2026, 5, 4), ticker="005930",
                       open=70000, high=71000, low=69500, close=70500,
                       volume=1_000_000, trading_value=70_000_000_000, change_rate=0.0071)
        assert q.ticker == "005930"

    def test_invalid_ticker_format_rejected(self):
        with pytest.raises(ValidationError):
            KoreaQuote(date=Date(2026, 5, 4), ticker="ABCDEF")

    def test_negative_volume_rejected(self):
        with pytest.raises(ValidationError):
            KoreaQuote(date=Date(2026, 5, 4), ticker="005930", volume=-1)

    def test_supply_demand_rejects_5char_ticker(self):
        with pytest.raises(ValidationError):
            KoreaSupplyDemand(date=Date(2026, 5, 4), ticker="00593")


# ───────────────────────────────────────────────────────────
# Symbol mapping (KOSPI → .KS, KOSDAQ → .KQ)
# ───────────────────────────────────────────────────────────
class TestYfSymbol:
    def test_kospi_uses_ks(self):
        assert KrxCollector._yf_symbol("005930", "KOSPI") == "005930.KS"

    def test_kosdaq_uses_kq(self):
        assert KrxCollector._yf_symbol("058470", "KOSDAQ") == "058470.KQ"

    def test_unknown_market_defaults_to_kospi(self):
        assert KrxCollector._yf_symbol("005930", "") == "005930.KS"


# ───────────────────────────────────────────────────────────
# yfinance success path (primary backend)
# ───────────────────────────────────────────────────────────
class TestYfinancePath:
    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("yfinance.download")
    @patch("pykrx.stock.get_market_trading_value_by_date")
    def test_yfinance_success_skips_pykrx(
        self, mock_supply, mock_yf, _mock_bizday, mock_storage,
    ):
        mock_yf.return_value = _yf_df({
            "005930.KS": [70000, 70200, 70500, 70800, 71000, 71200, 71500, 71800, 72000, 72500],
            "000660.KS": [180_000, 181_000, 182_000, 183_000, 184_000,
                          185_000, 186_000, 187_000, 188_000, 189_000],
        })
        mock_supply.return_value = pd.DataFrame([
            {"외국인합계": 5_000_000_000, "기관합계": -2_000_000_000},
        ])

        coll = KrxCollector(watchlist=WATCHLIST_2)
        result = coll.fetch(Date(2026, 5, 4))

        # Both tickers picked up via yfinance + supply demand from pykrx.
        # 2 * (1 quote + 1 supply) = 4 items
        assert result.success_count == 4
        assert result.failure_count == 0
        assert mock_storage.called

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("yfinance.download")
    def test_yfinance_kosdaq_uses_kq_suffix(
        self, mock_yf, _mock_bizday, mock_storage,
    ):
        mock_yf.return_value = _yf_df({
            "058470.KQ": [200_000, 201_000, 202_000, 203_000, 204_000,
                          205_000, 206_000, 207_000, 208_000, 209_000],
        })

        coll = KrxCollector(watchlist=WATCHLIST_KOSDAQ)
        coll.fetch(Date(2026, 5, 4))
        # Verify yfinance called with .KQ suffix
        kwargs = mock_yf.call_args.kwargs
        assert "058470.KQ" in kwargs.get("tickers", [])

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("yfinance.download")
    @patch("pykrx.stock.get_market_trading_value_by_date")
    def test_yfinance_change_rate_derived_from_prev_close(
        self, mock_supply, mock_yf, _mock_bizday, mock_storage,
    ):
        # closes: ..., 100_000 (prev), 102_000 (target) → +2%
        mock_yf.return_value = _yf_df({
            "005930.KS": [
                100_000, 100_000, 100_000, 100_000, 100_000,
                100_000, 100_000, 100_000, 100_000, 102_000,
            ],
        })
        mock_supply.return_value = pd.DataFrame()    # empty → no supply row

        coll = KrxCollector(watchlist=[{"ticker": "005930", "market": "KOSPI"}])
        result = coll.fetch(Date(2026, 5, 4))

        quotes = [it for it in result.items if isinstance(it, KoreaQuote)]
        assert len(quotes) == 1
        assert quotes[0].close == 102_000
        assert quotes[0].change_rate == pytest.approx((102_000 - 100_000) / 100_000, abs=1e-6)


# ───────────────────────────────────────────────────────────
# pykrx fallback path
# ───────────────────────────────────────────────────────────
class TestPykrxFallback:
    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("yfinance.download", side_effect=RuntimeError("yahoo down"))
    @patch("pykrx.stock.get_market_trading_value_by_date")
    @patch("pykrx.stock.get_market_ohlcv_by_ticker")
    def test_falls_back_to_pykrx_when_yfinance_fails(
        self, mock_pykrx_ohlcv, mock_supply, _mock_yf, _mock_bizday, mock_storage,
    ):
        mock_pykrx_ohlcv.return_value = _ohlcv_pykrx_df({"005930": _ohlcv_pykrx_row()})
        mock_supply.return_value = pd.DataFrame([
            {"외국인합계": 100, "기관합계": -50},
        ])

        coll = KrxCollector(watchlist=[{"ticker": "005930", "market": "KOSPI"}])
        result = coll.fetch(Date(2026, 5, 4))

        # pykrx fallback delivers quote + supply
        assert result.success_count == 2
        assert result.failure_count == 0

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("yfinance.download", side_effect=RuntimeError("yahoo down"))
    @patch("pykrx.stock.get_market_ohlcv_by_ticker", side_effect=KeyError("krx down"))
    def test_both_backends_fail_records_per_ticker_failure(
        self, _mock_pykrx, _mock_yf, _mock_bizday, mock_storage,
    ):
        coll = KrxCollector(watchlist=[{"ticker": "005930", "market": "KOSPI"}])
        result = coll.fetch(Date(2026, 5, 4))
        assert result.success_count == 0
        assert result.failure_count >= 1


# ───────────────────────────────────────────────────────────
# Supply / demand graceful degradation
# ───────────────────────────────────────────────────────────
class TestSupplyDemand:
    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("yfinance.download")
    @patch("pykrx.stock.get_market_trading_value_by_date",
           side_effect=RuntimeError("KRX 503"))
    def test_supply_failure_does_not_block_quote(
        self, _mock_supply, mock_yf, _mock_bizday, mock_storage,
    ):
        mock_yf.return_value = _yf_df({
            "005930.KS": [70000] * 9 + [71000],
        })
        coll = KrxCollector(watchlist=[{"ticker": "005930", "market": "KOSPI"}])
        result = coll.fetch(Date(2026, 5, 4))

        # Quote present, supply absent — no failures recorded for the ticker.
        quotes = [it for it in result.items if isinstance(it, KoreaQuote)]
        supplies = [it for it in result.items if isinstance(it, KoreaSupplyDemand)]
        assert len(quotes) == 1
        assert len(supplies) == 0
        assert result.failure_count == 0


# ───────────────────────────────────────────────────────────
# Business-day calendar smoke tests
# ───────────────────────────────────────────────────────────
class TestBusinessDayLogic:
    def test_prev_kr_business_day_returns_weekday_strictly_before(self):
        from collectors.utils.business_days import prev_kr_business_day
        result = prev_kr_business_day(Date(2026, 6, 10))
        assert result < Date(2026, 6, 10)
        assert result.weekday() < 5

    def test_prev_kr_business_day_skips_weekend(self):
        from collectors.utils.business_days import prev_kr_business_day
        assert prev_kr_business_day(Date(2026, 6, 9)) == Date(2026, 6, 8)

    def test_prev_kr_business_day_skips_korean_labor_day(self):
        from collectors.utils.business_days import prev_kr_business_day
        # 2026-05-04 (Mon). Prev: 5/1 (Fri) = 근로자의날 → 4/30 (Thu).
        assert prev_kr_business_day(Date(2026, 5, 4)) == Date(2026, 4, 30)
