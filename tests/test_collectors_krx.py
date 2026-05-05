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

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("pykrx.stock.get_market_trading_value_by_date")
    @patch("pykrx.stock.get_market_ohlcv_by_ticker")
    def test_bulk_ohlcv_falls_back_when_one_market_keyerrors(
        self, mock_ohlcv, mock_supply, _mock_bizday, mock_storage,
    ):
        """Regression: pykrx raised KeyError for market='ALL' when one market
        returned an empty payload. Now we fetch KOSPI + KOSDAQ separately and
        tolerate per-market failures, as long as at least one returns data."""
        kospi_df = _make_ohlcv_df({"005930": _ohlcv_row()})

        def per_market(_ymd, market):
            if market == "KOSPI":
                return kospi_df
            # Simulate the KeyError that pykrx raises when KRX returns empty.
            raise KeyError("None of [Index(['시가', '고가', '저가', '종가'], "
                           "dtype='object')] are in the [columns]")

        mock_ohlcv.side_effect = per_market
        mock_supply.return_value = pd.DataFrame([
            {"외국인합계": 0, "기관합계": 0},
        ])

        coll = KrxCollector(tickers=["005930"])
        result = coll.fetch(Date(2026, 5, 4))
        # KOSPI returned 005930 → quote + supply succeed.
        assert result.success_count == 2
        assert result.failure_count == 0

    @patch("collectors.krx.prev_kr_business_day", return_value=Date(2026, 5, 1))
    @patch("pykrx.stock.get_market_ohlcv_by_ticker",
           side_effect=KeyError("internal pandas error"))
    def test_bulk_ohlcv_both_markets_fail(
        self, _mock_ohlcv, _mock_bizday, mock_storage,
    ):
        coll = KrxCollector(tickers=["005930"])
        result = coll.fetch(Date(2026, 5, 4))
        # Both markets KeyError → bulk fetch raises RuntimeError ('both empty')
        # → per-ticker loop records 1 failure for the bulk and 1 per ticker.
        assert result.success_count == 0
        assert result.failure_count >= 1


class TestBusinessDayLogic:
    """Smoke tests — pandas_market_calendars (XKRX) must skip weekends + KR holidays."""

    def test_prev_kr_business_day_returns_weekday_strictly_before(self):
        from collectors.utils.business_days import prev_kr_business_day
        result = prev_kr_business_day(Date(2026, 6, 10))   # Wed (no nearby KR holidays)
        assert result < Date(2026, 6, 10)
        assert result.weekday() < 5                         # Mon-Fri

    def test_prev_kr_business_day_skips_weekend(self):
        from collectors.utils.business_days import prev_kr_business_day
        # 2026-06-09 is a Tuesday with no KR holidays → previous trading day = Mon 2026-06-08.
        assert prev_kr_business_day(Date(2026, 6, 9)) == Date(2026, 6, 8)

    def test_prev_kr_business_day_skips_korean_labor_day(self):
        from collectors.utils.business_days import prev_kr_business_day
        # 2026-05-04 is Monday. Previous: weekend (5/2-3), then 5/1 (Fri) = 근로자의날 (KRX holiday).
        # → Should land on 2026-04-30 (Thu).
        assert prev_kr_business_day(Date(2026, 5, 4)) == Date(2026, 4, 30)
