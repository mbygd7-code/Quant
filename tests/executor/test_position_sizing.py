"""Sizing-policy tests — the pro-grade rules must actually bind."""
from __future__ import annotations

from executor.position_sizing import (
    Candidate,
    SizingParams,
    conviction,
    deploy_fraction,
    target_budgets,
)

P = SizingParams()
EQ = 100_000_000


def cand(t="005930", sector="반도체", grade="STRONG_BUY", score=1.5, conf=0.8, sigma=0.02):
    return Candidate(t, sector, grade, score, conf, sigma)


# ─── conviction ────────────────────────────────────────────────────


def test_conviction_strong_buy_beats_buy():
    assert conviction(cand(grade="STRONG_BUY"), P) > conviction(cand(grade="BUY"), P)


def test_conviction_zero_for_non_buy_grades():
    assert conviction(cand(grade="HOLD"), P) == 0.0
    assert conviction(cand(grade="RISK"), P) == 0.0


def test_conviction_scales_with_score_and_confidence():
    hi = conviction(cand(score=2.0, conf=1.0), P)
    lo = conviction(cand(score=0.4, conf=0.3), P)
    assert hi > lo
    assert 0.0 < lo < hi <= 1.0


# ─── deployment ────────────────────────────────────────────────────


def test_regime_off_deploys_nothing():
    assert deploy_fraction(P, risk_on=False, drawdown=0.0) == 0.0


def test_drawdown_throttle_halves():
    full = deploy_fraction(P, risk_on=True, drawdown=0.0)
    cut = deploy_fraction(P, risk_on=True, drawdown=0.10)
    assert cut == full / 2


# ─── budgets ───────────────────────────────────────────────────────


def base_kwargs(**over):
    kw = dict(
        equity=EQ,
        free_cash=EQ,
        held_weights={},
        held_sector_weights={},
        risk_on=True,
        drawdown=0.0,
    )
    kw.update(over)
    return kw


def test_higher_conviction_gets_bigger_budget():
    cands = [
        cand("A00001", grade="STRONG_BUY", score=1.8, conf=0.9),
        cand("B00002", grade="BUY", score=0.5, conf=0.5),
    ]
    b = target_budgets(cands, **base_kwargs())
    assert b["A00001"] > b["B00002"]


def test_riskier_name_gets_smaller_budget():
    calm = cand("A00001", sigma=0.015)
    wild = cand("B00002", sigma=0.06)
    b = target_budgets([calm, wild], **base_kwargs())
    assert b["A00001"] > b.get("B00002", 0)


def test_vol_cap_binds_on_high_sigma():
    # σ=5%: vol cap = 0.015/(2×0.05) = 15% of equity — below single cap.
    wild = cand("A00001", sigma=0.05, score=2.0, conf=1.0)
    b = target_budgets([wild], **base_kwargs())
    assert b["A00001"] <= int(0.015 / (2 * 0.05) * EQ) + 1


def test_single_name_cap_binds():
    # σ tiny → vol cap huge → single_cap (20%) must bind.
    one = cand("A00001", sigma=0.009, score=2.0, conf=1.0)
    b = target_budgets([one], **base_kwargs())
    assert b["A00001"] <= int(P.single_cap * EQ) + 1


def test_sector_cap_blocks_fourth_semi():
    semis = [cand(f"A0000{i}", sector="반도체", sigma=0.012, score=2.0, conf=1.0) for i in range(4)]
    b = target_budgets(semis, **base_kwargs())
    total_semi = sum(b.values())
    assert total_semi <= int(P.sector_cap * EQ) + 4  # rounding slack


def test_sector_room_respects_existing_holdings():
    b = target_budgets(
        [cand("A00001", sector="반도체")],
        **base_kwargs(held_sector_weights={"반도체": 0.38}),
    )
    # only 2% sector room < 3% min ticket → skipped
    assert b == {}


def test_min_ticket_skips_dust():
    weak = cand("A00001", grade="BUY", score=0.1, conf=0.1, sigma=0.06)
    strong = [cand(f"B0000{i}", score=2.0, conf=1.0) for i in range(8)]
    b = target_budgets(strong + [weak], **base_kwargs())
    assert "A00001" not in b or b["A00001"] >= int(P.min_ticket * EQ)


def test_free_cash_is_never_exceeded():
    cands = [cand(f"A0000{i}", sector=None, score=2.0, conf=1.0) for i in range(6)]
    b = target_budgets(cands, **base_kwargs(free_cash=25_000_000))
    assert sum(b.values()) <= 25_000_000


def test_invested_book_reduces_room():
    cands = [cand("A00001", sector=None, score=2.0, conf=1.0, sigma=0.009)]
    full = target_budgets(cands, **base_kwargs())
    half = target_budgets(cands, **base_kwargs(held_weights={"Z99999": 0.85}))
    # 85% already invested vs 90% target → ~5% room < min... allow ≤
    assert sum(half.values()) < sum(full.values())


def test_regime_off_means_no_budgets():
    b = target_budgets([cand()], **base_kwargs(risk_on=False))
    assert b == {}


# ─── learned multipliers flow through ──────────────────────────────


def test_learned_sector_mult_shifts_budget():
    # Two identical names in different sectors; learned sector_mult
    # favors 반도체 over 바이오. Both σ tiny so caps don't mask the tilt.
    favored = cand("A00001", sector="반도체", sigma=0.012, score=1.0, conf=0.7)
    penalized = cand("B00002", sector="바이오/헬스", sigma=0.012, score=1.0, conf=0.7)
    params = SizingParams(sector_mult={"반도체": 1.2, "바이오/헬스": 0.5})
    b = target_budgets([favored, penalized], params=params, **base_kwargs())
    assert b["A00001"] > b["B00002"]


def test_learned_grade_mult_demotes_distrusted_grade():
    # A learned policy that distrusts BUY (0.30) should shrink a BUY
    # budget vs the default 0.65.
    c = cand("A00001", sector=None, grade="BUY", sigma=0.012, score=1.5, conf=0.8)
    default = target_budgets([c], **base_kwargs())
    distrust = target_budgets(
        [c],
        params=SizingParams(grade_mult={"STRONG_BUY": 1.0, "BUY": 0.30}),
        **base_kwargs(),
    )
    assert distrust.get("A00001", 0) < default["A00001"]

def test_short_pressure_dampens_budget_bounded():
    clean = cand("A00001", sector=None, sigma=0.012, score=1.5, conf=0.8)
    shorted = Candidate("B00002", None, "STRONG_BUY", 1.5, 0.8, 0.012, short_pressure=1.0)
    b = target_budgets([clean, shorted], **base_kwargs())
    assert b["A00001"] > b["B00002"]          # dampened, not equal
    assert b["B00002"] > 0                     # ...but never vetoed
    # max dampening is 40% of conviction → budget ratio stays bounded
    assert b["B00002"] >= b["A00001"] * 0.4
