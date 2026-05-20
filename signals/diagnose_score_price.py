"""
Score ↔ price correlation diagnostic.

Answers the single most important question right now: do our AI scores
actually predict next-N-day returns?

For each (ticker, date) in `ai_scores` over the last N days:
  - Read final_score + 8 sub_scores
  - Read korea_market close at t, t+1, t+5, t+10
  - Compute forward log-returns at +1 / +5 / +10
  - Spearman ρ between each score column and each forward return

Output (stdout, markdown-friendly):
  1. Per-horizon overall Spearman (final_score vs return)
  2. Per-voter Spearman (which sub_scores carry signal vs noise)
  3. Per-sector breakdown of final_score correlation
  4. Per-ticker ranking (top-5 best + worst)

Run:
  python -m signals.diagnose_score_price                # last 90 days
  python -m signals.diagnose_score_price --days 180     # half-year window

Interpretation cheatsheet:
  |ρ| ≥ 0.20  — meaningful predictive signal
  0.10 ≤ |ρ| < 0.20  — weak but useful at scale
  |ρ| < 0.10  — indistinguishable from noise; either the score is wrong
                or this timeframe is wrong for the signal
  ρ < 0  — anti-signal (score says greed → market falls)
"""
from __future__ import annotations

import argparse
import math
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable

from db.supabase_client import get_admin_client

# Sub-score columns to evaluate individually. Order matches scorer.WeightConfig.
SUB_SCORE_COLS: tuple[str, ...] = (
    "global_market_score",
    "sector_score",
    "related_us_stock_score",
    "news_sentiment_score",
    "fundamental_score",
    "volume_flow_score",
    "risk_penalty",
    "kr_fear_greed_score",  # added in migration 25; may be NULL pre-deploy
)
ALL_SCORE_COLS: tuple[str, ...] = ("final_score",) + SUB_SCORE_COLS
HORIZONS: tuple[int, ...] = (1, 5, 10)


@dataclass(frozen=True)
class ScoreRow:
    date: date
    ticker: str
    scores: dict[str, float | None]


@dataclass(frozen=True)
class PriceRow:
    date: date
    ticker: str
    close: float


# ── Spearman helpers ─────────────────────────────────────────────
# Hand-rolled so the script has zero external dependencies beyond what
# the rest of the project already imports (supabase, stdlib). For ~10k
# pairs the O(n log n) tie-aware ranking is fine.

def _rank_with_ties(xs: list[float]) -> list[float]:
    """Average-rank ties (the 'fractional rank' convention scipy uses)."""
    indexed = sorted(enumerate(xs), key=lambda p: p[1])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(indexed):
        j = i
        while j + 1 < len(indexed) and indexed[j + 1][1] == indexed[i][1]:
            j += 1
        # ranks 1-based within the run i..j
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[indexed[k][0]] = avg
        i = j + 1
    return ranks


def spearman(xs: list[float], ys: list[float]) -> tuple[float, int]:
    """Return (ρ, n). ρ is NaN if n<3 or one side is constant."""
    pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
    n = len(pairs)
    if n < 3:
        return float("nan"), n
    xs2, ys2 = zip(*pairs)
    rx = _rank_with_ties(list(xs2))
    ry = _rank_with_ties(list(ys2))
    mean_rx = sum(rx) / n
    mean_ry = sum(ry) / n
    num = sum((a - mean_rx) * (b - mean_ry) for a, b in zip(rx, ry))
    den_x = math.sqrt(sum((a - mean_rx) ** 2 for a in rx))
    den_y = math.sqrt(sum((b - mean_ry) ** 2 for b in ry))
    if den_x == 0 or den_y == 0:
        return float("nan"), n
    return num / (den_x * den_y), n


# ── Data loaders ─────────────────────────────────────────────────

def _fetch_scores(start: date, end: date) -> list[ScoreRow]:
    sb = get_admin_client()
    cols = ",".join(("date", "ticker") + ALL_SCORE_COLS)
    # Supabase JS-style range is inclusive; .gte/.lte mirrors it server-side.
    res = (
        sb.table("ai_scores")
        .select(cols)
        .gte("date", start.isoformat())
        .lte("date", end.isoformat())
        .execute()
    )
    out: list[ScoreRow] = []
    for r in res.data or []:
        out.append(
            ScoreRow(
                date=date.fromisoformat(r["date"]),
                ticker=r["ticker"],
                scores={c: r.get(c) for c in ALL_SCORE_COLS},
            )
        )
    return out


def _fetch_prices(start: date, end: date) -> dict[tuple[str, date], float]:
    """Return {(ticker, date): close}. We need close prices through `end + max(HORIZONS)`."""
    sb = get_admin_client()
    res = (
        sb.table("korea_market")
        .select("ticker, date, close")
        .gte("date", start.isoformat())
        .lte("date", end.isoformat())
        .execute()
    )
    out: dict[tuple[str, date], float] = {}
    for r in res.data or []:
        if r.get("close") is None:
            continue
        out[(r["ticker"], date.fromisoformat(r["date"]))] = float(r["close"])
    return out


def _fetch_sectors() -> dict[str, str]:
    sb = get_admin_client()
    res = sb.table("stocks").select("ticker, sector").execute()
    return {r["ticker"]: (r.get("sector") or "unknown") for r in (res.data or [])}


# ── Forward-return computation ───────────────────────────────────

def _next_trading_close(
    prices: dict[tuple[str, date], float], ticker: str, on: date, horizon: int
) -> float | None:
    """Walk forward up to horizon + 5 calendar days looking for the Nth trading
    day's close. Returns None if the data window doesn't cover it.
    """
    needed = horizon
    cursor = on
    # Hard cap so a missing-data tail doesn't loop forever.
    for _ in range(horizon + 7):
        cursor = cursor + timedelta(days=1)
        if (ticker, cursor) in prices:
            needed -= 1
            if needed == 0:
                return prices[(ticker, cursor)]
    return None


# ── Aggregation + reporting ──────────────────────────────────────

def _print_md_table(headers: Iterable[str], rows: Iterable[Iterable[str]]) -> None:
    headers_l = list(headers)
    print("| " + " | ".join(headers_l) + " |")
    print("|" + "|".join(["---"] * len(headers_l)) + "|")
    for row in rows:
        print("| " + " | ".join(row) + " |")
    print()


def _fmt_rho(rho: float) -> str:
    if math.isnan(rho):
        return "n/a"
    sign = "+" if rho >= 0 else ""
    return f"{sign}{rho:.3f}"


def _rho_sort_key(row: list[str]) -> float:
    """Sort key that pushes 'n/a' rows to the bottom regardless of rule."""
    cell = row[1]
    if cell == "n/a" or cell == "—":
        return -1.0
    try:
        return abs(float(cell))
    except ValueError:
        return -1.0


def _strength_tag(rho: float) -> str:
    if math.isnan(rho):
        return ""
    a = abs(rho)
    if a >= 0.20:
        return "🟢 strong"
    if a >= 0.10:
        return "🟡 weak"
    return "🔴 noise"


def diagnose(days: int) -> int:
    today = date.today()
    score_end = today - timedelta(days=max(HORIZONS))  # so all horizons have prices
    score_start = score_end - timedelta(days=days)
    price_end = today

    print(f"# Score↔Price diagnostic — last {days} days")
    print(f"score window: {score_start} → {score_end} (horizons {HORIZONS} days)\n")

    print("Loading ai_scores …", file=sys.stderr)
    scores = _fetch_scores(score_start, score_end)
    if not scores:
        print("**No ai_scores rows in window.** Pipeline may not have produced output yet.")
        return 1
    print(f"Loading korea_market (through {price_end}) …", file=sys.stderr)
    prices = _fetch_prices(score_start, price_end)
    print(f"Loading stocks.sector …", file=sys.stderr)
    sectors = _fetch_sectors()

    print(f"scored rows: {len(scores):,}   price rows: {len(prices):,}\n")

    # Build aligned (score_value, forward_return) lists, indexed by:
    #   - score column × horizon (global stats)
    #   - sector × horizon (sector breakdown, final_score only)
    #   - ticker × horizon (ticker ranking, final_score only)
    pairs_by_col_h: dict[tuple[str, int], list[tuple[float, float]]] = defaultdict(list)
    pairs_by_sector_h: dict[tuple[str, int], list[tuple[float, float]]] = defaultdict(list)
    pairs_by_ticker_h: dict[tuple[str, int], list[tuple[float, float]]] = defaultdict(list)

    skipped_no_price = 0
    for s in scores:
        close_t = prices.get((s.ticker, s.date))
        if close_t is None or close_t <= 0:
            skipped_no_price += 1
            continue
        for h in HORIZONS:
            close_th = _next_trading_close(prices, s.ticker, s.date, h)
            if close_th is None or close_th <= 0:
                continue
            ret = math.log(close_th / close_t)
            for col in ALL_SCORE_COLS:
                v = s.scores.get(col)
                if v is None:
                    continue
                pairs_by_col_h[(col, h)].append((float(v), ret))
            fv = s.scores.get("final_score")
            if fv is not None:
                sec = sectors.get(s.ticker, "unknown")
                pairs_by_sector_h[(sec, h)].append((float(fv), ret))
                pairs_by_ticker_h[(s.ticker, h)].append((float(fv), ret))

    if skipped_no_price:
        print(
            f"_skipped {skipped_no_price:,} rows lacking a t-day close in korea_market._\n"
        )
        # When the skip count equals the score-row count, the join is fully
        # broken — show samples so the user can see why.
        if skipped_no_price == len(scores):
            print("### Diagnostic: every score row failed price lookup\n")
            print("First 5 score (ticker, date) keys:\n")
            for s in scores[:5]:
                close_t = prices.get((s.ticker, s.date))
                print(
                    f"  ai_scores: ticker={s.ticker!r:<12} date={s.date}  "
                    f"→ korea_market hit: {close_t is not None}"
                )
            print("\nFirst 5 korea_market (ticker, date) keys:\n")
            for k in list(prices.keys())[:5]:
                print(f"  korea_market: ticker={k[0]!r:<12} date={k[1]}")
            # Cross-check by ticker only (ignore date)
            score_tickers = {s.ticker for s in scores}
            price_tickers = {k[0] for k in prices.keys()}
            common = score_tickers & price_tickers
            print(
                f"\n  unique tickers — ai_scores: {len(score_tickers)},  "
                f"korea_market: {len(price_tickers)},  intersection: {len(common)}"
            )
            if not common:
                print(
                    "\n  ⚠️ Zero ticker overlap. Likely a format mismatch "
                    "(e.g. one side has leading zeros, the other does not)."
                )
            else:
                # Same ticker exists in both — must be a date mismatch.
                sample = next(iter(common))
                score_dates_for = sorted(
                    {s.date for s in scores if s.ticker == sample}
                )[:5]
                price_dates_for = sorted(
                    {k[1] for k in prices.keys() if k[0] == sample}
                )[:5]
                print(
                    f"\n  ticker {sample!r} has both — date samples:"
                    f"\n    ai_scores dates: {score_dates_for}"
                    f"\n    korea_market dates: {price_dates_for}"
                )
            print()

    # ── (1) Per-horizon final_score ────────────────────────────
    print("## 1. final_score vs forward return\n")
    rows = []
    for h in HORIZONS:
        pts = pairs_by_col_h[("final_score", h)]
        if not pts:
            rows.append([f"t+{h}", "—", "0", ""])
            continue
        xs, ys = zip(*pts)
        rho, n = spearman(list(xs), list(ys))
        rows.append([f"t+{h}", _fmt_rho(rho), f"{n:,}", _strength_tag(rho)])
    _print_md_table(["horizon", "Spearman ρ", "n pairs", "verdict"], rows)

    # ── (2) Per voter sub-score, t+1 ───────────────────────────
    print("## 2. sub-score signal strength (t+1 horizon)\n")
    voter_rows = []
    for col in SUB_SCORE_COLS:
        pts = pairs_by_col_h[(col, 1)]
        if not pts:
            voter_rows.append([col, "n/a", "0", ""])
            continue
        xs, ys = zip(*pts)
        rho, n = spearman(list(xs), list(ys))
        voter_rows.append([col, _fmt_rho(rho), f"{n:,}", _strength_tag(rho)])
    # Sort strongest signal first (by |ρ|, ignoring NaN).
    voter_rows.sort(key=_rho_sort_key, reverse=True)
    _print_md_table(["sub_score column", "Spearman ρ", "n pairs", "verdict"], voter_rows)

    # ── (3) Per-sector breakdown, t+1 final_score ─────────────
    print("## 3. final_score by sector (t+1 horizon)\n")
    sector_rows = []
    for sec, h in sorted(pairs_by_sector_h.keys()):
        if h != 1:
            continue
        pts = pairs_by_sector_h[(sec, h)]
        xs, ys = zip(*pts)
        rho, n = spearman(list(xs), list(ys))
        sector_rows.append([sec, _fmt_rho(rho), f"{n:,}", _strength_tag(rho)])
    sector_rows.sort(key=_rho_sort_key, reverse=True)
    _print_md_table(["sector", "Spearman ρ", "n pairs", "verdict"], sector_rows)

    # ── (4) Per-ticker top/bottom 5, t+1 final_score ──────────
    print("## 4. final_score by ticker — top/bottom 5 (t+1 horizon)\n")
    ticker_results: list[tuple[str, float, int]] = []
    for tk, h in pairs_by_ticker_h.keys():
        if h != 1:
            continue
        pts = pairs_by_ticker_h[(tk, h)]
        if len(pts) < 10:
            continue  # need enough samples
        xs, ys = zip(*pts)
        rho, n = spearman(list(xs), list(ys))
        if not math.isnan(rho):
            ticker_results.append((tk, rho, n))
    ticker_results.sort(key=lambda r: r[1], reverse=True)
    top5 = ticker_results[:5]
    bot5 = ticker_results[-5:][::-1]
    rows = []
    for tk, rho, n in top5:
        rows.append([f"top · {tk}", _fmt_rho(rho), f"{n}", _strength_tag(rho)])
    for tk, rho, n in bot5:
        rows.append([f"bot · {tk}", _fmt_rho(rho), f"{n}", _strength_tag(rho)])
    _print_md_table(["ticker", "Spearman ρ", "n pairs", "verdict"], rows)

    # ── Verdict ──────────────────────────────────────────────
    print("## Reading the result\n")
    print(
        "- Section 1 is the headline. If all three horizons show 🔴 noise, the score\n"
        "  carries no directional info and we should pivot the model target to\n"
        "  forward return (see chat — recommendation #6).\n"
        "- Section 2 names the voters worth keeping vs. demoting.\n"
        "  Anti-signal (negative ρ) voters need their sign flipped in scorer.py.\n"
        "- Section 3 tells whether one sector (e.g. 반도체) drags the average.\n"
        "  A green sector inside a red overall = the model works selectively.\n"
        "- Section 4 surfaces stocks where the score works — and which it doesn't.\n"
    )
    return 0


def diagnose_and_persist(days: int) -> int:
    """Like diagnose() but also writes every (scope, horizon) row into the
    model_diagnostics table for the weekly cron + admin dashboard."""
    today = date.today()
    score_end = today - timedelta(days=max(HORIZONS))
    score_start = score_end - timedelta(days=days)
    price_end = today

    print(f"# Score↔Price diagnostic — last {days} days (persisting to DB)")
    print(f"score window: {score_start} → {score_end}\n")

    scores = _fetch_scores(score_start, score_end)
    if not scores:
        print("No ai_scores rows in window — nothing to persist.")
        return 1
    prices = _fetch_prices(score_start, price_end)
    sectors = _fetch_sectors()

    pairs_by_col_h: dict[tuple[str, int], list[tuple[float, float]]] = defaultdict(list)
    pairs_by_sector_h: dict[tuple[str, int], list[tuple[float, float]]] = defaultdict(list)
    for s in scores:
        close_t = prices.get((s.ticker, s.date))
        if close_t is None or close_t <= 0:
            continue
        for h in HORIZONS:
            close_th = _next_trading_close(prices, s.ticker, s.date, h)
            if close_th is None or close_th <= 0:
                continue
            ret = math.log(close_th / close_t)
            for col in ALL_SCORE_COLS:
                v = s.scores.get(col)
                if v is None:
                    continue
                pairs_by_col_h[(col, h)].append((float(v), ret))
            fv = s.scores.get("final_score")
            if fv is not None:
                sec = sectors.get(s.ticker, "unknown")
                pairs_by_sector_h[(sec, h)].append((float(fv), ret))

    out_rows: list[dict] = []
    # Overall = final_score per horizon.
    for h in HORIZONS:
        xs_ys = pairs_by_col_h.get(("final_score", h), [])
        rho, n = (float("nan"), 0) if not xs_ys else spearman(*map(list, zip(*xs_ys)))
        out_rows.append(
            {
                "run_date": today.isoformat(),
                "window_days": days,
                "scope_kind": "overall",
                "scope_name": "final_score",
                "horizon_days": h,
                "spearman_rho": None if math.isnan(rho) else rho,
                "n_pairs": n,
            }
        )
    # Per voter (all sub_scores) at every horizon.
    for col in SUB_SCORE_COLS:
        for h in HORIZONS:
            xs_ys = pairs_by_col_h.get((col, h), [])
            rho, n = (float("nan"), 0) if not xs_ys else spearman(*map(list, zip(*xs_ys)))
            out_rows.append(
                {
                    "run_date": today.isoformat(),
                    "window_days": days,
                    "scope_kind": "voter",
                    "scope_name": col,
                    "horizon_days": h,
                    "spearman_rho": None if math.isnan(rho) else rho,
                    "n_pairs": n,
                }
            )
    # Per sector at every horizon.
    for (sec, h), xs_ys in pairs_by_sector_h.items():
        rho, n = (float("nan"), 0) if not xs_ys else spearman(*map(list, zip(*xs_ys)))
        out_rows.append(
            {
                "run_date": today.isoformat(),
                "window_days": days,
                "scope_kind": "sector",
                "scope_name": sec,
                "horizon_days": h,
                "spearman_rho": None if math.isnan(rho) else rho,
                "n_pairs": n,
            }
        )

    sb = get_admin_client()
    # BATCH insert; small enough to fit a single call (≤ 8 voters × 3 horizons
    # + 1 overall × 3 + ~10 sectors × 3 = ~63 rows).
    sb.table("model_diagnostics").insert(out_rows).execute()
    print(f"Persisted {len(out_rows)} diagnostic rows to model_diagnostics.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Score↔price predictive-power diagnostic")
    p.add_argument("--days", type=int, default=90, help="lookback window (default 90)")
    p.add_argument(
        "--persist",
        action="store_true",
        help="write results into model_diagnostics table (for weekly cron)",
    )
    args = p.parse_args()
    if args.persist:
        return diagnose_and_persist(args.days)
    return diagnose(args.days)


if __name__ == "__main__":
    raise SystemExit(main())
