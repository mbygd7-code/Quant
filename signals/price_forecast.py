"""Daily 5-trading-day price forecast — recorded, evaluated, self-calibrating.

The accuracy loop this module implements:

  1. RECORD   — every pipeline run, write one immutable forecast row per
                watchlist ticker into price_forecasts, including the
                AI-expert consensus (Soros weighted_score) that tilted it.
  2. EVALUATE — rows whose target_date has passed get filled with the
                realized close → direction_hit / within_band / abs_pct_err.
  3. CALIBRATE— the evaluated ledger feeds back into new forecasts:
                  k        = corr(expert_score, realized log return)
                             → how strongly expert opinion tilts the drift
                  band_mult= adjusts the 95% cone toward true 95% coverage
                Until ≥ MIN_CALIB_N evaluated rows exist, k uses a small
                fixed prior — honest about not yet having evidence.

Math (mirrors apps/web/app/api/kr-forecast/route.ts — keep in sync):
  point(h) = base · exp(gap + (μ_eff + tilt) · h)
  band(h)  = base · exp(gap + (μ_eff + tilt) · h ± 1.96 · band_mult · σ · √h)
  tilt     = k · (expert_score / 2) · σ        (per-day, bounded by ±k·σ)

Expert score ∈ [-2, +2] (Soros Q2-adjusted weighted_score) so the tilt
is at most ±k daily sigmas — experts nudge the path, they never replace
the statistics. This is what makes the audit meaningful: if their calls
correlate with realized returns, k grows and they move forecasts more;
if not, k decays toward 0 and the forecast ignores them.
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import date as Date
from datetime import datetime, timedelta

from db.supabase_client import fetch_all, get_admin_client

log = logging.getLogger("signals.price_forecast")

HORIZON = 5
LOOKBACK = 40
MIN_RETURNS = 10
DRIFT_SHRINK = 0.5
Z_95 = 1.959964

OVERNIGHT_MIN_R2 = 0.08
OVERNIGHT_GAP_CAP_VOL = 2.5

#: Prior expert-tilt strength before enough evaluated rows exist.
K_PRIOR = 0.15
#: Evaluated rows needed before calibration replaces the prior.
MIN_CALIB_N = 20
#: k is clamped to this range — even perfect correlation must not let
#: expert opinion dominate the statistical base. 0 floor: anti-signal
#: (negative corr) zeroes the tilt rather than inverting expert calls.
K_MAX = 0.5

MODEL = "rw_drift_overnight_expert_v1"


@dataclass
class Calibration:
    k: float
    band_mult: float
    n_evaluated: int
    direction_hit_rate: float | None
    coverage: float | None
    median_abs_err: float | None


def _mean(xs: list[float]) -> float:
    return sum(xs) / len(xs)


def _stdev(xs: list[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _corr(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 3:
        return None
    mx, my = _mean(xs), _mean(ys)
    sx, sy = _stdev(xs), _stdev(ys)
    if sx == 0 or sy == 0:
        return None
    cov = sum((a - mx) * (b - my) for a, b in zip(xs, ys)) / (len(xs) - 1)
    return cov / (sx * sy)


def _round100(v: float) -> int:
    return int(round(v / 100.0) * 100)


def _add_trading_days(d: Date, n: int) -> Date:
    cur = d
    added = 0
    while added < n:
        cur = cur + timedelta(days=1)
        if cur.weekday() < 5:
            added += 1
    return cur


# ─── Calibration from the evaluated ledger ─────────────────────────


def load_calibration(sb) -> Calibration:
    """Pooled (cross-ticker) calibration from evaluated forecast rows.

    Pooling is deliberate: per-ticker n grows ~1/day, far too slow.
    The expert system is shared across tickers, so its trust score
    should be too.
    """
    rows = fetch_all(
        sb.table("price_forecasts")
        .select(
            "expert_score, base_price, actual, predicted, lower_band, "
            "upper_band, direction_hit, within_band, abs_pct_err, horizon_days"
        )
        .not_.is_("actual", "null")
    )
    n = len(rows)
    if n == 0:
        return Calibration(K_PRIOR, 1.0, 0, None, None, None)

    hits = [r["direction_hit"] for r in rows if r.get("direction_hit") is not None]
    inband = [r["within_band"] for r in rows if r.get("within_band") is not None]
    errs = sorted(r["abs_pct_err"] for r in rows if r.get("abs_pct_err") is not None)
    hit_rate = (sum(1 for h in hits if h) / len(hits)) if hits else None
    coverage = (sum(1 for b in inband if b) / len(inband)) if inband else None
    median_err = errs[len(errs) // 2] if errs else None

    k = K_PRIOR
    band_mult = 1.0
    if n >= MIN_CALIB_N:
        # k ← correlation between the experts' score and the realized
        # per-day log return over the horizon. Negative → 0 (don't invert).
        xs, ys = [], []
        for r in rows:
            es = r.get("expert_score")
            if es is None or not r.get("actual") or not r.get("base_price"):
                continue
            h = r.get("horizon_days") or HORIZON
            xs.append(float(es))
            ys.append(math.log(r["actual"] / r["base_price"]) / h)
        c = _corr(xs, ys)
        if c is not None:
            k = max(0.0, min(K_MAX, c))
        # band_mult ← push realized coverage toward 95%. Bounded so a
        # noisy early sample can't blow the cone up or collapse it.
        if coverage is not None:
            if coverage < 0.80:
                band_mult = 1.25
            elif coverage < 0.90:
                band_mult = 1.10
            elif coverage > 0.99:
                band_mult = 0.90

    return Calibration(k, band_mult, n, hit_rate, coverage, median_err)


# ─── Forecast inputs ───────────────────────────────────────────────


def _closes(sb, ticker: str, bars: int) -> list[tuple[str, float]]:
    rows = (
        sb.table("korea_market")
        .select("date, close")
        .eq("ticker", ticker)
        .not_.is_("close", "null")
        .order("date", desc=True)
        .limit(bars)
        .execute()
        .data
        or []
    )
    return [(r["date"], float(r["close"])) for r in reversed(rows)]


def _overnight_gap(sb, ticker: str, last_date: str, sigma: float) -> float:
    rows = (
        sb.table("kr_overnight_betas")
        .select("us_symbol, beta, r_squared")
        .eq("kr_ticker", ticker)
        .order("r_squared", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows or (rows[0].get("r_squared") or 0) < OVERNIGHT_MIN_R2:
        return 0.0
    b = rows[0]
    us = (
        sb.table("global_market")
        .select("change_rate")
        .eq("symbol", b["us_symbol"])
        .lte("date", last_date)
        .not_.is_("change_rate", "null")
        .order("date", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not us:
        return 0.0
    raw = float(b["beta"]) * float(us[0]["change_rate"])
    cap = OVERNIGHT_GAP_CAP_VOL * sigma
    return max(-cap, min(cap, raw))


def _latest_expert(sb, ticker: str, last_date: str) -> tuple[float | None, str | None]:
    """Most recent Soros final signal within 3 days of the base date."""
    since = (Date.fromisoformat(last_date) - timedelta(days=3)).isoformat()
    rows = (
        sb.table("final_signals")
        .select("weighted_score, signal_grade, cycle_at")
        .eq("ticker", ticker)
        .gte("cycle_at", since)
        .order("cycle_at", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return None, None
    r = rows[0]
    ws = r.get("weighted_score")
    return (float(ws) if ws is not None else None), r.get("signal_grade")


# ─── Record ────────────────────────────────────────────────────────


def build_forecast_row(sb, ticker: str, calib: Calibration) -> dict | None:
    """One ledger row for `ticker` based on its latest close. None if
    there isn't enough history (refinery rule: never fabricate)."""
    hist = _closes(sb, ticker, LOOKBACK + 1)
    if len(hist) < MIN_RETURNS + 1:
        return None
    closes = [c for _, c in hist]
    rets = [
        math.log(closes[i] / closes[i - 1])
        for i in range(1, len(closes))
        if closes[i - 1] > 0 and closes[i] > 0
    ]
    if len(rets) < MIN_RETURNS:
        return None

    mu_eff = _mean(rets) * DRIFT_SHRINK
    sigma = _stdev(rets)
    base = closes[-1]
    last_date = hist[-1][0]

    gap = _overnight_gap(sb, ticker, last_date, sigma)
    expert_score, expert_grade = _latest_expert(sb, ticker, last_date)
    tilt = (
        calib.k * (expert_score / 2.0) * sigma if expert_score is not None else 0.0
    )

    h = HORIZON
    log_center = gap + (mu_eff + tilt) * h
    half = Z_95 * calib.band_mult * sigma * math.sqrt(h)
    target = _add_trading_days(Date.fromisoformat(last_date), h)

    return {
        "ticker": ticker,
        "forecast_date": last_date,
        "target_date": target.isoformat(),
        "horizon_days": h,
        "base_price": int(base),
        "predicted": _round100(base * math.exp(log_center)),
        "lower_band": _round100(base * math.exp(log_center - half)),
        "upper_band": _round100(base * math.exp(log_center + half)),
        "mu_eff": round(mu_eff, 8),
        "sigma": round(sigma, 8),
        "overnight_gap": round(gap, 8),
        "expert_score": expert_score,
        "expert_grade": expert_grade,
        "expert_tilt": round(tilt, 8),
        "calib_k": round(calib.k, 4),
        "band_mult": calib.band_mult,
        "model": MODEL,
    }


def record_forecasts(sb) -> dict[str, int]:
    """Write today's forecast row for every watchlist ticker.

    Insert-only semantics: an existing (ticker, forecast_date) row is
    never overwritten — the ledger must be immutable for the audit to
    mean anything.
    """
    calib = load_calibration(sb)
    tickers = sorted(
        r["ticker"]
        for r in (
            sb.table("stocks").select("ticker").eq("is_watchlist", True).execute().data
            or []
        )
    )
    written = 0
    skipped = 0
    for t in tickers:
        row = build_forecast_row(sb, t, calib)
        if row is None:
            skipped += 1
            continue
        try:
            sb.table("price_forecasts").upsert(
                row, on_conflict="ticker,forecast_date", ignore_duplicates=True
            ).execute()
            written += 1
        except Exception as exc:
            log.warning("[forecast] %s record failed: %s", t, exc)
            skipped += 1
    log.info(
        "[forecast] recorded %d / skipped %d (k=%.3f band_mult=%.2f n_eval=%d)",
        written, skipped, calib.k, calib.band_mult, calib.n_evaluated,
    )
    return {
        "recorded": written,
        "skipped": skipped,
        "calib_k": calib.k,
        "n_evaluated": calib.n_evaluated,
    }


# ─── Evaluate ──────────────────────────────────────────────────────


def evaluate_due(sb, today: Date | None = None) -> int:
    """Fill evaluation columns for rows whose target_date has passed.

    The realized close is the FIRST korea_market close on/after
    target_date (holidays push it forward); if none exists yet the row
    stays pending for the next run.
    """
    today = today or Date.today()
    due = fetch_all(
        sb.table("price_forecasts")
        .select("ticker, forecast_date, target_date, base_price, predicted, lower_band, upper_band")
        .is_("actual", "null")
        .lte("target_date", today.isoformat())
    )
    evaluated = 0
    for r in due:
        actuals = (
            sb.table("korea_market")
            .select("date, close")
            .eq("ticker", r["ticker"])
            .gte("date", r["target_date"])
            .not_.is_("close", "null")
            .order("date")
            .limit(1)
            .execute()
            .data
            or []
        )
        if not actuals:
            continue
        actual = float(actuals[0]["close"])
        base = float(r["base_price"])
        pred = float(r["predicted"])
        direction_hit = (pred - base) * (actual - base) > 0 or (
            pred == base and abs(actual - base) / base < 0.005
        )
        patch = {
            "actual": int(actual),
            "actual_date": actuals[0]["date"],
            "direction_hit": bool(direction_hit),
            "within_band": bool(r["lower_band"] <= actual <= r["upper_band"]),
            "abs_pct_err": round(abs(actual - pred) / actual, 6),
            "evaluated_at": datetime.utcnow().isoformat() + "Z",
        }
        sb.table("price_forecasts").update(patch).eq("ticker", r["ticker"]).eq(
            "forecast_date", r["forecast_date"]
        ).execute()
        evaluated += 1
    log.info("[forecast] evaluated %d rows (of %d due)", evaluated, len(due))
    return evaluated


# ─── CLI (daily pipeline step) ─────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    sb = get_admin_client()
    n_eval = evaluate_due(sb)
    summary = record_forecasts(sb)
    print(f"[price_forecast] evaluated={n_eval} {summary}")
