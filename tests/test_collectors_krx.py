"""KrxCollector — validation, partial failure, business-day math, raw backup."""
from __future__ import annotations

from datetime import date as Date
from unittest.mock import patch

import pandas as pd
import pytest
from pydantic import ValidationError

from collectors.__schemas__.korea import KoreaQuote, KoreaSupplyDemand
from collectors.krx import KrxCollector


def _ohlcv_row(open_=70000, high=71000, low=69500, close=70500,
               volume=1_000_000, value=70_000_000_000, change=0.0071):
    return {"시가": open_, "고가": high, "저가": low, "종가": close,
            "거래량": volume, "거래대금": value, "등락률": change * 100}


def _make_ohlcv_df(rows: dict[str, dict]) -> pd.DataFrame:
    return pd.DataFrame.from_dict(rows, orient="index")


# ───────────────────────────────────────────────────────────
# Pydantic model validation
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
# KrxCollector behavior
# ───────────────────────────────────────────────────────────
class TestKrxCollector:
    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("pykrx.stock.get_market_trading_value_by_date")
    @patch("pykrx.stock.get_market_ohlcv_by_ticker")
    def test_fetch_collects_all_tickers(
        self, mock_ohlcv, mock_supply, _mock_bizday, mock_storage,
    ):
        mock_ohlcv.return_value = _make_ohlcv_df({
            "005930": _ohlcv_row(),
            "000660": _ohlcv_row(open_=180_000, close=182_000),
        })
        mock_supply.return_value = pd.DataFrame([
            {"외국인합계": 5_000_000_000, "기관합계": -2_000_000_000},
        ])

        coll = KrxCollector(tickers=["005930", "000660"])
        result = coll.fetch(Date(2026, 5, 4))

        # 2 tickers × (1 quote + 1 supply) = 4 items
        assert result.success_count == 4
        assert result.failure_count == 0
        assert result.success_rate == 1.0
        assert mock_storage.called

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("pykrx.stock.get_market_trading_value_by_date")
    @patch("pykrx.stock.get_market_ohlcv_by_ticker")
    def test_partial_failure_does_not_abort(
        self, mock_ohlcv, mock_supply, _mock_bizday, mock_storage,
    ):
        # 005930 present in OHLCV; 000660 missing → expected per-ticker failure.
        mock_ohlcv.return_value = _make_ohlcv_df({"005930": _ohlcv_row()})
        mock_supply.return_value = pd.DataFrame([
            {"외국인합계": 0, "기관합계": 0},
        ])

        coll = KrxCollector(tickers=["005930", "000660"])
        result = coll.fetch(Date(2026, 5, 4))

        assert result.success_count == 2          # quote + supply for 005930 only
        assert result.failure_count == 1          # 000660 missing
        assert result.failed[0]["identifier"] == "000660"
        assert result.success_rate == pytest.approx(2 / 3)

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("pykrx.stock.get_market_ohlcv_by_ticker", side_effect=RuntimeError("KRX down"))
    def test_bulk_ohlcv_failure_records_but_continues(
        self, _mock_ohlcv, _mock_bizday, mock_storage,
    ):
        coll = KrxCollector(tickers=["005930"])
        # bulk_ohlcv failure is captured; per-ticker loop then fails individually too.
        result = coll.fetch(Date(2026, 5, 4))
        assert result.success_count == 0
        assert result.failure_count >= 1


class TestBusinessDayLogic:
    """Smoke test — pandas_market_calendars must agree on a known date."""

    def test_prev_kr_business_day_for_monday(self):
        from collectors.utils.business_days import prev_kr_business_day
        # 2026-05-04 is a Monday → previous trading day should be Friday 2026-05-01.
        assert prev_kr_business_day(Date(2026, 5, 4)) == Date(2026, 5, 1)
