"""Trading-policy learner — Soros gets smarter from his own trade ledger.

The evolution loop (mirrors the proven price-forecast calibration):

  1. REPLAY   — reconstruct round-trip episodes (buy → full sell) from
                the immutable paper_bot_trades ledger.
  2. MEASURE  — per-bucket evidence:
                  · grade buckets   (STRONG_BUY / BUY): win rate, avg net
                    return per episode
                  · stop-loss exits: post-exit price path → whipsaw rate
                    (stopped out, then price recovered = the stop was too
                    tight) vs saved rate (price kept falling = stop worked)
                  · sector buckets : win rate per sector
  3. ADAPT    — bounded, gated parameter updates:
                  grade_mult     ∈ [0.30, 1.00], step ≤ ±0.15, n ≥ 10
                  stop_loss_pct  ∈ [-0.15, -0.07], step ±0.01, n ≥ 8 stops
                  sector_mult    ∈ [0.50, 1.20], step ≤ ±0.15, n ≥ 8
                Buckets below their sample gate keep the previous value —
                Soros never learns from noise, and a hard bound means a
                bad month can't talk him into recklessness.
  4. RECORD   — append a new version to paper_policy_state with the
                evidence and a human-readable note; Telegram the change.

The bot reads the LATEST version every cycle (load_policy), so skill
compounds automatically as episodes accumulate.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field

from db.supabase_client import fetch_all, get_admin_client

log = logging.getLogger("executor.policy_learner")

# ─── Hard bounds & gates (the learner's constitution) ──────────────
GRADE_BOUNDS = (0.30, 1.00)
GRADE_STEP = 0.15
GRADE_MIN_N = 10

STOP_BOUNDS = (-0.15, -0.07)
STOP_STEP = 0.01
STOP_MIN_N = 8
WHIPSAW_LOOKAHEAD_D = 10      # days after a stop to judge recovery
WHIPSAW_RECOVER = 1.03        # price ≥ exit×this within lookahead = whipsaw

SECTOR_BOUNDS = (0.50, 1.20)
SECTOR_STEP = 0.15
SECTOR_MIN_N = 8

DEFAULT_PARAMS: dict = {
    "grade_mult": {"STRONG_BUY": 1.0, "BUY": 0.65},
    "stop_loss_pct": -0.10,
    "sector_mult": {},
}


@dataclass
class Episode:
    """One completed round trip."""
    ticker: str
    sector: str | None
    grade: str | None            # grade at entry
    entry_score: float | None
    entry_date: str
    exit_date: str
    cost: int                    # total buy cost (incl fees)
    proceeds: int                # net sell proceeds
    ret: float                   # net return
    was_stop: bool               # exit reason was a stop-loss
    exit_price: int


@dataclass
class PolicyUpdate:
    params: dict
    evidence: dict
    notes: list[str] = field(default_factory=list)
    n_episodes: int = 0


# ─── 1. REPLAY ─────────────────────────────────────────────────────


def build_episodes(trades: list[dict], sectors: dict[str, str | None]) -> list[Episode]:
    """Pair buys with the full-exit sell that closes them, per ticker.

    The bot always exits full positions, so an episode = consecutive
    buys since the last sell, closed by the next sell. Trades must be
    in chronological order.
    """
    open_buys: dict[str, list[dict]] = {}
    episodes: list[Episode] = []
    for t in sorted(trades, key=lambda x: (x["trade_date"], x["id"])):
        if t["side"] == "buy":
            open_buys.setdefault(t["ticker"], []).append(t)
            continue
        buys = open_buys.pop(t["ticker"], [])
        if not buys:
            continue  # sell without recorded entry (pre-reset residue)
        cost = sum(int(b["amount"]) + int(b["fee"] or 0) for b in buys)
        proceeds = int(t["amount"]) - int(t["fee"] or 0) - int(t["tax"] or 0)
        first = buys[0]
        episodes.append(
            Episode(
                ticker=t["ticker"],
                sector=sectors.get(t["ticker"]),
                grade=first.get("signal_grade"),
                entry_score=first.get("weighted_score"),
                entry_date=first["trade_date"],
                exit_date=t["trade_date"],
                cost=cost,
                proceeds=proceeds,
                ret=(proceeds - cost) / cost if cost > 0 else 0.0,
                was_stop="손절" in (t.get("reason") or ""),
                exit_price=int(t["price"]),
            )
        )
    return episodes


# ─── 2. MEASURE ────────────────────────────────────────────────────


def bucket_stats(episodes: list[Episode]) -> dict:
    """Win rates / avg returns per grade and per sector + stop counts."""
    def agg(eps: list[Episode]) -> dict:
        n = len(eps)
        wins = sum(1 for e in eps if e.ret > 0)
        avg = sum(e.ret for e in eps) / n if n else 0.0
        return {"n": n, "win_rate": round(wins / n, 3) if n else None,
                "avg_ret": round(avg, 4)}

    grades: dict[str, dict] = {}
    for g in ("STRONG_BUY", "BUY"):
        grades[g] = agg([e for e in episodes if e.grade == g])
    sectors: dict[str, dict] = {}
    for sec in sorted({e.sector for e in episodes if e.sector}):
        sectors[sec] = agg([e for e in episodes if e.sector == sec])
    stops = [e for e in episodes if e.was_stop]
    return {
        "grades": grades,
        "sectors": sectors,
        "stops": {"n": len(stops), "avg_ret": agg(stops)["avg_ret"] if stops else None},
        "total": agg(episodes),
    }


def stop_whipsaw_rate(
    stops: list[Episode], price_after: dict[tuple[str, str], float]
) -> float | None:
    """Share of stop-outs where price recovered ≥ +3% within 10 days.

    `price_after[(ticker, exit_date)]` = max close in the lookahead
    window. High whipsaw rate → the stop is shaking us out of names
    that come right back → widen it. Low → the stop is genuinely
    catching falling knives → can tighten.
    """
    judged = []
    for e in stops:
        mx = price_after.get((e.ticker, e.exit_date))
        if mx is None:
            continue
        judged.append(mx >= e.exit_price * WHIPSAW_RECOVER)
    if not judged:
        return None
    return sum(judged) / len(judged)


# ─── 3. ADAPT (pure, bounded, gated) ───────────────────────────────


def _step_toward(current: float, target: float, step: float, bounds: tuple[float, float]) -> float:
    lo, hi = bounds
    moved = current + max(-step, min(step, target - current))
    return round(max(lo, min(hi, moved)), 4)


def adapt_params(
    prev: dict, stats: dict, whipsaw: float | None
) -> PolicyUpdate:
    """One bounded learning step from the evidence."""
    params = {
        "grade_mult": dict(prev.get("grade_mult", DEFAULT_PARAMS["grade_mult"])),
        "stop_loss_pct": prev.get("stop_loss_pct", DEFAULT_PARAMS["stop_loss_pct"]),
        "sector_mult": dict(prev.get("sector_mult", {})),
    }
    notes: list[str] = []

    # Grade trust: map win_rate → target multiplier. 50% win ≈ neutral
    # anchor (0.30 + 1.4×0.2 = 0.58); 65%+ earns near-full trust.
    for g, st in stats["grades"].items():
        if st["n"] < GRADE_MIN_N or st["win_rate"] is None:
            continue
        target = 0.30 + 1.4 * max(0.0, st["win_rate"] - 0.30)
        old = params["grade_mult"].get(g, DEFAULT_PARAMS["grade_mult"].get(g, 0.65))
        new = _step_toward(old, target, GRADE_STEP, GRADE_BOUNDS)
        if abs(new - old) >= 0.01:
            params["grade_mult"][g] = new
            notes.append(
                f"{g} 신뢰배수 {old:.2f}→{new:.2f} (승률 {st['win_rate']:.0%}, n={st['n']})"
            )

    # Stop-loss: whipsaw-driven.
    if stats["stops"]["n"] >= STOP_MIN_N and whipsaw is not None:
        old = params["stop_loss_pct"]
        if whipsaw > 0.50:
            new = _step_toward(old, old - STOP_STEP, STOP_STEP, STOP_BOUNDS)
            if new != old:
                params["stop_loss_pct"] = new
                notes.append(
                    f"손절선 {old:.0%}→{new:.0%} 완화 (휩쏘율 {whipsaw:.0%} — 손절 후 반등이 과반)"
                )
        elif whipsaw < 0.25:
            new = _step_toward(old, old + STOP_STEP, STOP_STEP, STOP_BOUNDS)
            if new != old:
                params["stop_loss_pct"] = new
                notes.append(
                    f"손절선 {old:.0%}→{new:.0%} 강화 (휩쏘율 {whipsaw:.0%} — 손절이 추가 하락을 차단)"
                )

    # Sector skill.
    for sec, st in stats["sectors"].items():
        if st["n"] < SECTOR_MIN_N or st["win_rate"] is None:
            continue
        target = 0.50 + 1.4 * max(0.0, st["win_rate"] - 0.30)
        old = params["sector_mult"].get(sec, 1.0)
        new = _step_toward(old, target, SECTOR_STEP, SECTOR_BOUNDS)
        if abs(new - old) >= 0.01:
            params["sector_mult"][sec] = new
            notes.append(
                f"{sec} 섹터배수 {old:.2f}→{new:.2f} (승률 {st['win_rate']:.0%}, n={st['n']})"
            )

    return PolicyUpdate(
        params=params,
        evidence={"stats": stats, "whipsaw_rate": whipsaw},
        notes=notes,
        n_episodes=stats["total"]["n"],
    )


# ─── 4. RECORD + load ──────────────────────────────────────────────


def load_policy(sb) -> dict:
    """Latest learned params (or defaults before any version exists).

    Defensive by design: any failure — table not yet migrated, transient
    DB error — falls back to DEFAULT_PARAMS so the trading bot can never
    be broken by the (optional) learning layer.
    """
    try:
        rows = (
            sb.table("paper_policy_state")
            .select("params")
            .order("version", desc=True)
            .limit(1)
            .execute()
            .data
            or []
        )
    except Exception as exc:
        log.warning("[policy] load failed (%s) — using DEFAULT_PARAMS", exc)
        return dict(DEFAULT_PARAMS)
    if not rows:
        return dict(DEFAULT_PARAMS)
    merged = dict(DEFAULT_PARAMS)
    merged.update(rows[0]["params"] or {})
    return merged


def learn(sb, send: bool = True) -> dict:
    """Full learning pass: replay → measure → adapt → record."""
    import httpx

    trades = fetch_all(sb.table("paper_bot_trades").select("*").order("trade_date"))
    tickers = sorted({t["ticker"] for t in trades})
    sectors = {}
    if tickers:
        for r in (
            sb.table("stocks").select("ticker, sector").in_("ticker", tickers).execute().data
            or []
        ):
            sectors[r["ticker"]] = r.get("sector")

    episodes = build_episodes(trades, sectors)
    stats = bucket_stats(episodes)

    # Post-stop price paths for the whipsaw judgement.
    stops = [e for e in episodes if e.was_stop]
    price_after: dict[tuple[str, str], float] = {}
    for e in stops:
        rows = (
            sb.table("korea_market")
            .select("date, close")
            .eq("ticker", e.ticker)
            .gt("date", e.exit_date)
            .not_.is_("close", "null")
            .order("date")
            .limit(WHIPSAW_LOOKAHEAD_D)
            .execute()
            .data
            or []
        )
        if rows:
            price_after[(e.ticker, e.exit_date)] = max(float(r["close"]) for r in rows)
    whipsaw = stop_whipsaw_rate(stops, price_after)

    prev = load_policy(sb)
    update = adapt_params(prev, stats, whipsaw)

    note_text = (
        " · ".join(update.notes)
        if update.notes
        else f"변경 없음 — 표본 부족 또는 파라미터 안정 (왕복거래 {update.n_episodes}건)"
    )
    sb.table("paper_policy_state").insert(
        {
            "params": update.params,
            "evidence": update.evidence,
            "notes": note_text,
            "n_episodes": update.n_episodes,
        }
    ).execute()
    log.info("[policy] v+1 — %s", note_text)

    if send and update.notes:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        chat = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "")
        if token and chat:
            msg = (
                "🧬 Soros 매매 정책 진화\n\n"
                + "\n".join(f"· {n}" for n in update.notes)
                + f"\n\n근거: 왕복거래 {update.n_episodes}건 분석. "
                "모든 변경은 한도 내 1스텝씩만 이동합니다."
            )
            httpx.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data={"chat_id": chat, "text": msg},
                timeout=15,
            )
    return {"n_episodes": update.n_episodes, "changes": len(update.notes), "notes": note_text}


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--no-send", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    print(learn(get_admin_client(), send=not args.no_send))
