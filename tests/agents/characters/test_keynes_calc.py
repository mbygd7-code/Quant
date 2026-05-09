"""Pure-function tests for Keynes' factor-contribution math."""
from __future__ import annotations

from datetime import date as Date
from datetime import timedelta
from decimal import Decimal

import pytest

from agents.characters._base import InsufficientDataError
from agents.characters._data import GlobalMarketRow, MacroBetaRow
from agents.characters.keynes import (
    MACRO_FACTORS,
    FactorContribution,
    KeynesInputs,
    expected_return_pct,
    factor_contribution,
    factor_delta_5d,
    score_from_expected_return,
)

# ─── helpers ────────────────────────────────────────────────────────


def _series(closes: list[float], symbol: str = "USDKRW") -> list[GlobalMarketRow]:
    today = Date(2026, 5, 9)
    return [
        GlobalMarketRow(
            date=today - timedelta(days=i),
            symbol=symbol,
            close=c,
            change_rate=0.0,
        )
        for i, c in enumerate(closes)
    ]


def _beta(factor: str, beta: float) -> MacroBetaRow:
    return MacroBetaRow(
        ticker="005930",
        macro_factor=factor,
        beta=beta,
        r_squared=0.5,
        n_samples=60,
    )


# ─── factor_delta_5d ────────────────────────────────────────────────


def test_delta_5d_simple_uptrend() -> None:
    """USDKRW 1300 → 1313 over 5 days = +1%."""
    series = _series([1313, 1310, 1308, 1306, 1303, 1300, 1300, 1300])
    out = factor_delta_5d(series)
    assert out == pytest.approx(1.0, abs=0.001)


def test_delta_5d_downtrend() -> None:
    series = _series([1287, 1290, 1293, 1296, 1298, 1300, 1300])
    out = factor_delta_5d(series)
    assert out == pytest.approx(-1.0, abs=0.001)


def test_delta_5d_short_window_returns_none() -> None:
    series = _series([1300] * 4)
    assert factor_delta_5d(series) is None


def test_delta_5d_zero_anchor_returns_none() -> None:
    """Defensive — protect against div/0 if a bad anchor close sneaks in."""
    series = _series([1.0, 1.0, 1.0, 1.0, 1.0, 0.0, 1.0])
    assert factor_delta_5d(series) is None


# ─── factor_contribution ───────────────────────────────────────────


def test_contribution_with_beta() -> None:
    """Ticker has β = -2.1 to USDKRW; USDKRW moved +1.0%.
    Expected contribution = -2.1 × 1.0 = -2.1%p.

    Series construction: closes[0] = today = 1313, closes[5] = anchor
    = 1300, so (1313 - 1300) / 1300 × 100 = +1.0%."""
    series = _series([1313, 1310, 1308, 1306, 1303, 1300, 1300, 1300])
    out = factor_contribution("USDKRW", series, _beta("USDKRW", -2.1))
    assert out.factor == "USDKRW"
    assert out.delta_5d_pct == pytest.approx(1.0, abs=0.05)
    assert out.beta == -2.1
    assert out.contribution_pct == pytest.approx(-2.1, abs=0.1)


def test_contribution_with_zero_beta_when_no_row() -> None:
    """No beta row → contribution is 0 (factor effectively excluded)."""
    series = _series([1313] + [1300] * 7)
    out = factor_contribution("USDKRW", series, None)
    assert out.beta == 0.0
    assert out.contribution_pct == 0.0


def test_contribution_with_short_series_treats_delta_as_zero() -> None:
    """When the macro series is too thin, delta defaults to 0 — the
    contribution disappears rather than crashing the cycle."""
    out = factor_contribution(
        "USDKRW", _series([1300] * 3), _beta("USDKRW", -2.0)
    )
    assert out.delta_5d_pct == 0.0
    assert out.contribution_pct == 0.0


# ─── expected_return_pct ────────────────────────────────────────────


def test_expected_return_sums_contributions() -> None:
    contribs = [
        FactorContribution("USDKRW", 1.0, -2.0, -2.0),
        FactorContribution("^TNX", -0.5, 1.0, -0.5),
        FactorContribution("^VIX", 0.0, 0.0, 0.0),
        FactorContribution("DXY", 0.5, -0.5, -0.25),
        FactorContribution("WTI", 2.0, 0.5, 1.0),
    ]
    out = expected_return_pct(contribs)
    assert out == pytest.approx(-1.75, abs=1e-9)


def test_expected_return_zero_when_no_contributions() -> None:
    assert expected_return_pct([]) == 0


# ─── score_from_expected_return ────────────────────────────────────


@pytest.mark.parametrize(
    ("expected_pct", "score"),
    [
        (4.0, "2.00"),       # cap at +2
        (4.5, "2.00"),       # cap holds beyond +4
        (2.0, "1.00"),       # 2.0 × 0.5 = 1.0
        (1.0, "0.50"),
        (0.0, "0"),
        (-1.0, "-0.50"),
        (-4.0, "-2.00"),
        (-10.0, "-2.00"),    # cap at -2
    ],
)
def test_score_from_expected_return_matrix(
    expected_pct: float, score: str
) -> None:
    out = score_from_expected_return(expected_pct)
    assert out == Decimal(score)


# ─── analyze() with mocked LLM ──────────────────────────────────────


def _full_inputs(*, betas: dict[str, MacroBetaRow]) -> KeynesInputs:
    """Synthetic 12-day series for every macro factor — ascending +1
    per day so the 5-day delta works out cleanly."""
    series_for = {
        f: _series([1310 + i for i in range(12)], symbol=f)
        for f in MACRO_FACTORS
    }
    return KeynesInputs(macro_series=series_for, betas=betas)


def test_analyze_raises_when_no_betas(monkeypatch: pytest.MonkeyPatch) -> None:
    from agents.characters import keynes as keynes_mod
    from agents.characters.keynes import Keynes

    # Stub the data-layer call so fetch() sees an empty dict.
    monkeypatch.setattr(keynes_mod, "macro_betas", lambda ticker: {})

    with pytest.raises(InsufficientDataError):
        Keynes().fetch("005930")


def test_analyze_returns_row_with_score(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agents.characters import keynes as keynes_mod
    from agents.characters.keynes import Keynes
    from agents.llm.client import ClaudeResult

    fake_result = ClaudeResult(
        text='{"narrative":"USDKRW 변동에 따른 영향이 가장 큽니다."}',
        model="claude-test",
        input_tokens=200,
        output_tokens=30,
        cost_estimate_usd=0.001,
    )
    fake_parsed = keynes_mod.KeynesLLMResponse(
        narrative="USDKRW 변동에 따른 영향이 가장 큽니다."
    )
    monkeypatch.setattr(
        keynes_mod, "call_claude", lambda **kwargs: (fake_result, fake_parsed)
    )

    inputs = _full_inputs(
        betas={
            "USDKRW": _beta("USDKRW", -2.0),
            "^TNX": _beta("^TNX", -0.5),
            # missing for the other 3 — should default to zero contribution
        }
    )

    from datetime import UTC
    from datetime import datetime as _dt

    out = Keynes().analyze(
        "005930", _dt(2026, 5, 9, 7, 0, tzinfo=UTC), inputs=inputs
    )

    assert out.agent_name == "keynes"
    assert out.ticker == "005930"
    assert -Decimal(2) <= out.score <= Decimal(2)
    payload = out.raw_payload
    assert payload["factors_with_beta"] == 2
    assert payload["factors_total"] == 5
    assert len(payload["factors"]) == 5
