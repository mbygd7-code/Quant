"""Tests for the 9th factor — 수출입 동향 (signals.kr_trade + collector parsing)."""
from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock, patch

from collectors.kr_trade import SECTOR_HS, compute_yoy
from signals.kr_trade import (
    MIN_HISTORY,
    NEUTRAL,
    compute_kr_trade,
    latest_published_period,
)

# ─── publication-lag gate (no look-ahead) ──────────────────────────


def test_latest_published_period_after_release_day():
    # On June 16th, May data (published ~June 15) is usable.
    assert latest_published_period(date(2026, 6, 16)) == "2026-05"


def test_latest_published_period_before_release_day():
    # On June 10th, May data is NOT yet out — only April.
    assert latest_published_period(date(2026, 6, 10)) == "2026-04"


def test_latest_published_period_january_wraparound():
    assert latest_published_period(date(2026, 1, 10)) == "2025-11"
    assert latest_published_period(date(2026, 1, 20)) == "2025-12"


# ─── YoY computation (collector) ───────────────────────────────────


def test_compute_yoy_fills_when_base_exists():
    rows = [
        {"hs_code": "8542", "period": "2025-03", "export_usd": 100},
        {"hs_code": "8542", "period": "2026-03", "export_usd": 150},
    ]
    compute_yoy(rows)
    assert rows[0]["export_yoy"] is None  # no 2024-03 base
    assert rows[1]["export_yoy"] == 50.0


def test_compute_yoy_never_fabricates_on_zero_base():
    rows = [
        {"hs_code": "8507", "period": "2025-01", "export_usd": 0},
        {"hs_code": "8507", "period": "2026-01", "export_usd": 500},
    ]
    compute_yoy(rows)
    assert rows[1]["export_yoy"] is None


# ─── subscore behaviour ────────────────────────────────────────────


def _mock_sb_with_rows(rows):
    sb = MagicMock()
    return sb, rows


def test_unknown_sector_is_neutral():
    assert compute_kr_trade("인터넷/AI", date(2026, 6, 10)).score == NEUTRAL
    assert compute_kr_trade(None, date(2026, 6, 10)).score == NEUTRAL


@patch("signals.kr_trade.fetch_all")
@patch("signals.kr_trade.get_admin_client")
def test_no_rows_is_neutral(mock_client, mock_fetch):
    mock_fetch.return_value = []
    res = compute_kr_trade("반도체", date(2026, 6, 20))
    assert res.score == NEUTRAL


@patch("signals.kr_trade.fetch_all")
@patch("signals.kr_trade.get_admin_client")
def test_short_history_is_neutral(mock_client, mock_fetch):
    # Only 13 months of values → at most 1 YoY point < MIN_HISTORY.
    rows = [
        {"hs_code": "8542", "period": f"2025-{m:02d}", "export_usd": 100 + m}
        for m in range(1, 13)
    ] + [{"hs_code": "8542", "period": "2026-01", "export_usd": 200}]
    mock_fetch.return_value = rows
    res = compute_kr_trade("반도체", date(2026, 6, 20))
    assert res.score == NEUTRAL
    assert res.n_history < MIN_HISTORY


@patch("signals.kr_trade.fetch_all")
@patch("signals.kr_trade.get_admin_client")
def test_record_high_yoy_scores_high(mock_client, mock_fetch):
    # 36 months: flat 100 for year 1, +10%/mo drift year 2, then a
    # blowout final month → latest YoY should rank near the top.
    rows = []
    for i in range(36):
        y, m = divmod(i, 12)
        val = 100 if y == 0 else (110 if y == 1 else 130)
        rows.append(
            {"hs_code": "8542", "period": f"{2023 + y}-{m + 1:02d}", "export_usd": val}
        )
    rows[-1]["export_usd"] = 400  # 2025-12 blowout vs 110 base
    mock_fetch.return_value = rows
    res = compute_kr_trade("반도체", date(2026, 1, 20))
    assert res.score > 0.9
    assert res.latest_period == "2025-12"


@patch("signals.kr_trade.fetch_all")
@patch("signals.kr_trade.get_admin_client")
def test_collapse_scores_low(mock_client, mock_fetch):
    rows = []
    for i in range(36):
        y, m = divmod(i, 12)
        val = 100 + i * 5  # steady growth
        rows.append(
            {"hs_code": "8507", "period": f"{2023 + y}-{m + 1:02d}", "export_usd": val}
        )
    rows[-1]["export_usd"] = 50  # crash in the final month
    mock_fetch.return_value = rows
    res = compute_kr_trade("2차전지", date(2026, 1, 20))
    assert res.score < 0.1


def test_all_watchlist_sectors_mapped_or_intentionally_absent():
    # 5 sectors in CLAUDE.md; 인터넷/AI intentionally has no HS codes.
    assert set(SECTOR_HS) == {"반도체", "2차전지", "자동차", "바이오/헬스"}


# ─── scorer integration ────────────────────────────────────────────


def test_weight_config_nine_factors_sum_to_one():
    from cognition.scorer import WeightConfig

    w = WeightConfig()
    total = (
        w.global_market + w.sector + w.related_us_stock + w.news_sentiment
        + w.fundamental + w.volume_flow + w.risk_penalty
        + w.kr_fear_greed + w.kr_trade
    )
    assert abs(total - 1.0) < 1e-9


def test_combine_includes_kr_trade_term():
    from cognition.__schemas__.scoring import SubScores
    from cognition.scorer import StockScorer, WeightConfig

    scorer = StockScorer.__new__(StockScorer)
    scorer._weights = WeightConfig()
    base = dict(
        global_market=0.5, sector=0.5, related_us_stock=0.5,
        news_sentiment=0.5, fundamental=0.5, volume_flow=0.5,
        risk_penalty=0.0, kr_fear_greed=0.5,
    )
    low = scorer._combine(SubScores(**base, kr_trade=0.0))
    high = scorer._combine(SubScores(**base, kr_trade=1.0))
    assert abs((high - low) - WeightConfig().kr_trade) < 1e-9
