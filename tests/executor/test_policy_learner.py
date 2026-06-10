"""Policy-learner tests — evolution must be bounded, gated, evidenced."""
from __future__ import annotations

from executor.policy_learner import (
    DEFAULT_PARAMS,
    Episode,
    adapt_params,
    bucket_stats,
    build_episodes,
    stop_whipsaw_rate,
)


def trade(id, date, ticker, side, qty=10, price=10000, fee=15, tax=0, grade="BUY", score=0.5, reason=""):
    return {
        "id": id, "trade_date": date, "ticker": ticker, "side": side,
        "qty": qty, "price": price, "amount": qty * price, "fee": fee,
        "tax": tax, "signal_grade": grade, "weighted_score": score,
        "reason": reason,
    }


def ep(ret=0.05, grade="BUY", sector="반도체", was_stop=False, ticker="A", exit_price=10000):
    cost = 1_000_000
    return Episode(
        ticker=ticker, sector=sector, grade=grade, entry_score=0.5,
        entry_date="2026-06-01", exit_date="2026-06-08",
        cost=cost, proceeds=int(cost * (1 + ret)), ret=ret,
        was_stop=was_stop, exit_price=exit_price,
    )


# ─── replay ────────────────────────────────────────────────────────


def test_build_episodes_pairs_buy_with_closing_sell():
    trades = [
        trade(1, "2026-06-01", "005930", "buy", qty=10, price=10000, fee=15),
        trade(2, "2026-06-08", "005930", "sell", qty=10, price=11000, fee=16, tax=165),
    ]
    eps = build_episodes(trades, {"005930": "반도체"})
    assert len(eps) == 1
    e = eps[0]
    assert e.cost == 100_015
    assert e.proceeds == 110_000 - 16 - 165
    assert e.ret > 0.09
    assert e.sector == "반도체"


def test_build_episodes_ignores_orphan_sell():
    eps = build_episodes([trade(1, "2026-06-01", "005930", "sell")], {})
    assert eps == []


def test_build_episodes_stop_flag_from_reason():
    trades = [
        trade(1, "2026-06-01", "A00001", "buy"),
        trade(2, "2026-06-05", "A00001", "sell", price=8900, reason="손절 -11.0% — 시가 체결 대기"),
    ]
    eps = build_episodes(trades, {})
    assert eps[0].was_stop is True


# ─── measure ───────────────────────────────────────────────────────


def test_bucket_stats_counts():
    eps = [ep(0.1, "STRONG_BUY"), ep(-0.05, "STRONG_BUY"), ep(0.02, "BUY")]
    st = bucket_stats(eps)
    assert st["grades"]["STRONG_BUY"]["n"] == 2
    assert st["grades"]["STRONG_BUY"]["win_rate"] == 0.5
    assert st["total"]["n"] == 3


def test_whipsaw_rate():
    stops = [ep(was_stop=True, ticker="A", exit_price=10000),
             ep(was_stop=True, ticker="B", exit_price=10000)]
    after = {("A", "2026-06-08"): 10500, ("B", "2026-06-08"): 9000}  # A recovered
    assert stop_whipsaw_rate(stops, after) == 0.5


# ─── adapt: gates ──────────────────────────────────────────────────


def test_small_sample_changes_nothing():
    eps = [ep(0.1, "BUY")] * 5  # n=5 < 10
    upd = adapt_params(DEFAULT_PARAMS, bucket_stats(eps), None)
    assert upd.params["grade_mult"] == DEFAULT_PARAMS["grade_mult"]
    assert upd.params["stop_loss_pct"] == DEFAULT_PARAMS["stop_loss_pct"]
    assert upd.notes == []


def test_losing_grade_loses_trust_bounded_step():
    eps = [ep(-0.05, "BUY", sector=None)] * 12  # 0% win rate, n=12
    upd = adapt_params(DEFAULT_PARAMS, bucket_stats(eps), None)
    new = upd.params["grade_mult"]["BUY"]
    assert new < 0.65
    assert new >= 0.65 - 0.15 - 1e-9  # one step max


def test_winning_grade_gains_trust():
    eps = [ep(0.06, "STRONG_BUY", sector=None)] * 12 + [ep(-0.02, "STRONG_BUY", sector=None)] * 3
    prev = {"grade_mult": {"STRONG_BUY": 0.7, "BUY": 0.65}, "stop_loss_pct": -0.10, "sector_mult": {}}
    upd = adapt_params(prev, bucket_stats(eps), None)
    assert upd.params["grade_mult"]["STRONG_BUY"] > 0.7


def test_grade_mult_never_leaves_bounds():
    eps = [ep(0.10, "STRONG_BUY", sector=None)] * 50
    p = dict(DEFAULT_PARAMS)
    for _ in range(20):  # many learning steps
        p = adapt_params(p, bucket_stats(eps), None).params
    assert p["grade_mult"]["STRONG_BUY"] <= 1.00
    losing = [ep(-0.08, "BUY", sector=None)] * 50
    for _ in range(20):
        p = adapt_params(p, bucket_stats(losing), None).params
    assert p["grade_mult"]["BUY"] >= 0.30


def test_high_whipsaw_widens_stop():
    eps = [ep(-0.10, was_stop=True, sector=None)] * 10
    upd = adapt_params(DEFAULT_PARAMS, bucket_stats(eps), whipsaw=0.7)
    assert upd.params["stop_loss_pct"] == -0.11


def test_low_whipsaw_tightens_stop():
    eps = [ep(-0.10, was_stop=True, sector=None)] * 10
    upd = adapt_params(DEFAULT_PARAMS, bucket_stats(eps), whipsaw=0.1)
    assert upd.params["stop_loss_pct"] == -0.09


def test_stop_never_leaves_bounds():
    eps = [ep(-0.10, was_stop=True, sector=None)] * 10
    p = dict(DEFAULT_PARAMS)
    for _ in range(20):
        p = adapt_params(p, bucket_stats(eps), whipsaw=0.9).params
    assert p["stop_loss_pct"] >= -0.15
    for _ in range(30):
        p = adapt_params(p, bucket_stats(eps), whipsaw=0.0).params
    assert p["stop_loss_pct"] <= -0.07


def test_sector_skill_learned_with_gate():
    good = [ep(0.06, "BUY", sector="반도체")] * 9
    bad = [ep(-0.04, "BUY", sector="바이오/헬스")] * 9
    upd = adapt_params(DEFAULT_PARAMS, bucket_stats(good + bad), None)
    assert upd.params["sector_mult"]["반도체"] > 1.0
    assert upd.params["sector_mult"]["바이오/헬스"] < 1.0
    assert 0.50 <= upd.params["sector_mult"]["바이오/헬스"] <= 1.20
