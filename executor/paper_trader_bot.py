"""Soros paper-trading bot — the live usability audit of the signals.

A single global virtual portfolio (paper_config singleton, default 1억원)
that trades the Soros consensus automatically after every agents cycle:

  BUY  — top final_signals (STRONG_BUY first, then BUY) by weighted_score,
         equal-slot sizing (equity / max_positions), while cash allows.
  SELL — full exit when a held name's latest grade is CAUTION or RISK.
  HOLD — everything else stays.

Realism (so the P&L means something):
  · execution at the signal day's CLOSE with ±0.05% adverse slippage
    (the 06:00 signal could realistically be traded during that session)
  · commission 0.015% per side (typical online brokerage)
  · securities transaction tax 0.15% on sells (2025~ KOSPI/KOSDAQ)
  · integer share quantities only; no leverage; cash can't go negative

Snapshots (paper_bot_snapshots) record the daily equity curve; the
weekly Telegram report (--weekly-report) summarizes trades and P&L.

This is EXECUTION_MODE=paper machinery only — no real broker API is
ever touched here (CLAUDE.md ABSOLUTE RULE D).
"""
from __future__ import annotations

import logging
import math
import os
from datetime import date as Date
from datetime import datetime, timedelta

from db.supabase_client import fetch_all, get_admin_client
from executor.safety import check_execution_mode

log = logging.getLogger("executor.paper_trader_bot")

COMMISSION_RATE = 0.00015   # 0.015% per side
SELL_TAX_RATE = 0.0015      # 0.15% securities transaction tax (2025~)
SLIPPAGE = 0.0005           # 0.05% adverse on both sides
BUY_GRADES = ("STRONG_BUY", "BUY")
SELL_GRADES = ("CAUTION", "RISK")
SIGNAL_FRESH_DAYS = 3       # only act on signals at most this old
MIN_CASH_FRACTION = 0.95    # need ≥ slot×this in cash to open


def _config(sb) -> dict:
    rows = sb.table("paper_config").select("*").eq("id", 1).execute().data
    if not rows:
        sb.table("paper_config").insert({"id": 1}).execute()
        rows = sb.table("paper_config").select("*").eq("id", 1).execute().data
    return rows[0]


def _latest_closes(sb, tickers: list[str]) -> dict[str, tuple[str, int]]:
    """ticker → (date, close) for the most recent close per ticker."""
    if not tickers:
        return {}
    out: dict[str, tuple[str, int]] = {}
    rows = fetch_all(
        sb.table("korea_market")
        .select("ticker, date, close")
        .in_("ticker", tickers)
        .not_.is_("close", "null")
        .order("date", desc=True)
    )
    for r in rows:
        if r["ticker"] not in out:
            out[r["ticker"]] = (r["date"], int(r["close"]))
    return out


def _latest_signals(sb, max_age_days: int = SIGNAL_FRESH_DAYS) -> dict[str, dict]:
    """ticker → latest final_signal row (within max_age_days)."""
    since = (datetime.utcnow() - timedelta(days=max_age_days)).isoformat()
    rows = fetch_all(
        sb.table("final_signals")
        .select("ticker, signal_grade, weighted_score, confidence, cycle_at")
        .gte("cycle_at", since)
        .order("cycle_at", desc=True)
    )
    out: dict[str, dict] = {}
    for r in rows:
        if r["ticker"] not in out:
            out[r["ticker"]] = r
    return out


def _names(sb, tickers: list[str]) -> dict[str, str]:
    if not tickers:
        return {}
    rows = (
        sb.table("stocks").select("ticker, name").in_("ticker", tickers).execute().data
        or []
    )
    return {r["ticker"]: r.get("name") or r["ticker"] for r in rows}


# ─── Trading cycle ─────────────────────────────────────────────────


def run_cycle(sb, today: Date | None = None) -> dict:
    check_execution_mode()
    today = today or Date.today()
    cfg = _config(sb)
    cash = int(cfg["cash"])
    max_pos = int(cfg["max_positions"])

    positions = {
        p["ticker"]: p
        for p in (sb.table("paper_bot_positions").select("*").execute().data or [])
    }
    signals = _latest_signals(sb)
    closes = _latest_closes(sb, sorted(set(positions) | set(signals)))

    trades: list[dict] = []
    realized_today = 0

    # ── SELL: held names whose latest grade turned negative ────────
    for ticker, pos in list(positions.items()):
        sig = signals.get(ticker)
        if not sig or sig["signal_grade"] not in SELL_GRADES:
            continue
        if ticker not in closes:
            continue
        _, close = closes[ticker]
        px = round(close * (1 - SLIPPAGE))
        qty = int(pos["qty"])
        gross = qty * px
        fee = round(gross * COMMISSION_RATE)
        tax = round(gross * SELL_TAX_RATE)
        net = gross - fee - tax
        pnl = net - qty * int(pos["avg_price"])
        cash += net
        realized_today += pnl
        trades.append(
            {
                "trade_date": today.isoformat(),
                "ticker": ticker,
                "side": "sell",
                "qty": qty,
                "price": px,
                "amount": gross,
                "fee": fee,
                "tax": tax,
                "signal_grade": sig["signal_grade"],
                "weighted_score": sig.get("weighted_score"),
                "reason": f"신호 하향({sig['signal_grade']}) 전량 청산",
                "realized_pnl": pnl,
            }
        )
        sb.table("paper_bot_positions").delete().eq("ticker", ticker).execute()
        del positions[ticker]

    # ── BUY: best fresh signals into empty slots ────────────────────
    equity = cash + sum(
        int(p["qty"]) * closes.get(t, (None, int(p["avg_price"])))[1]
        for t, p in positions.items()
    )
    slot = equity // max_pos if max_pos > 0 else 0

    candidates = sorted(
        (
            s
            for t, s in signals.items()
            if s["signal_grade"] in BUY_GRADES and t not in positions and t in closes
        ),
        key=lambda s: (
            0 if s["signal_grade"] == "STRONG_BUY" else 1,
            -(s.get("weighted_score") or 0),
        ),
    )
    for sig in candidates:
        if len(positions) >= max_pos:
            break
        if cash < slot * MIN_CASH_FRACTION:
            break
        ticker = sig["ticker"]
        _, close = closes[ticker]
        px = round(close * (1 + SLIPPAGE))
        budget = min(slot, cash)
        qty = math.floor(budget / (px * (1 + COMMISSION_RATE)))
        if qty <= 0:
            continue
        gross = qty * px
        fee = round(gross * COMMISSION_RATE)
        cash -= gross + fee
        # cost basis includes the buy fee, spread over shares.
        avg = round((gross + fee) / qty)
        trades.append(
            {
                "trade_date": today.isoformat(),
                "ticker": ticker,
                "side": "buy",
                "qty": qty,
                "price": px,
                "amount": gross,
                "fee": fee,
                "tax": 0,
                "signal_grade": sig["signal_grade"],
                "weighted_score": sig.get("weighted_score"),
                "reason": f"{sig['signal_grade']} 신호 진입 (점수 {sig.get('weighted_score')})",
                "realized_pnl": None,
            }
        )
        sb.table("paper_bot_positions").upsert(
            {
                "ticker": ticker,
                "qty": qty,
                "avg_price": avg,
                "opened_at": today.isoformat(),
                "updated_at": datetime.utcnow().isoformat() + "Z",
            }
        ).execute()
        positions[ticker] = {"ticker": ticker, "qty": qty, "avg_price": avg}

    if trades:
        sb.table("paper_bot_trades").insert(trades).execute()
    sb.table("paper_config").update(
        {"cash": cash, "updated_at": datetime.utcnow().isoformat() + "Z"}
    ).eq("id", 1).execute()

    # ── Snapshot ────────────────────────────────────────────────────
    invested = 0
    unrealized = 0
    for t, p in positions.items():
        close = closes.get(t, (None, int(p["avg_price"])))[1]
        invested += int(p["qty"]) * close
        unrealized += int(p["qty"]) * (close - int(p["avg_price"]))
    realized_cum = sum(
        int(r["realized_pnl"] or 0)
        for r in fetch_all(
            sb.table("paper_bot_trades").select("realized_pnl").eq("side", "sell")
        )
    )
    total = cash + invested
    initial = int(cfg["initial_capital"])
    sb.table("paper_bot_snapshots").upsert(
        {
            "snap_date": today.isoformat(),
            "total_value": total,
            "cash": cash,
            "invested": invested,
            "unrealized_pnl": unrealized,
            "realized_pnl_cum": realized_cum,
            "ret_pct": round((total - initial) / initial * 100, 4),
            "n_positions": len(positions),
        }
    ).execute()

    summary = {
        "buys": sum(1 for t in trades if t["side"] == "buy"),
        "sells": sum(1 for t in trades if t["side"] == "sell"),
        "realized_today": realized_today,
        "cash": cash,
        "total_value": total,
        "ret_pct": round((total - initial) / initial * 100, 2),
        "positions": len(positions),
    }
    log.info("[paper_bot] %s", summary)
    return summary


# ─── Reset (capital edit) ──────────────────────────────────────────


def reset(sb, initial_capital: int | None = None) -> None:
    """Wipe the bot portfolio and restart from `initial_capital`."""
    cfg = _config(sb)
    capital = int(initial_capital or cfg["initial_capital"])
    sb.table("paper_bot_trades").delete().neq("id", 0).execute()
    sb.table("paper_bot_positions").delete().neq("qty", 0).execute()
    sb.table("paper_bot_snapshots").delete().neq("total_value", -1).execute()
    sb.table("paper_config").update(
        {
            "initial_capital": capital,
            "cash": capital,
            "started_at": datetime.utcnow().isoformat() + "Z",
            "updated_at": datetime.utcnow().isoformat() + "Z",
        }
    ).eq("id", 1).execute()
    log.info("[paper_bot] reset → %s원", f"{capital:,}")


# ─── Weekly Telegram report ────────────────────────────────────────


def weekly_report(sb, send: bool = True) -> str:
    """Compose (and optionally send) the weekly P&L report."""
    import httpx

    cfg = _config(sb)
    initial = int(cfg["initial_capital"])
    week_ago = (Date.today() - timedelta(days=7)).isoformat()

    snaps = fetch_all(
        sb.table("paper_bot_snapshots").select("*").order("snap_date")
    )
    latest = snaps[-1] if snaps else None
    week_start = next((s for s in snaps if s["snap_date"] >= week_ago), None)

    trades = fetch_all(
        sb.table("paper_bot_trades")
        .select("*")
        .gte("trade_date", week_ago)
        .order("trade_date")
    )
    positions = sb.table("paper_bot_positions").select("*").execute().data or []
    closes = _latest_closes(sb, [p["ticker"] for p in positions])
    names = _names(sb, [p["ticker"] for p in positions] + [t["ticker"] for t in trades])

    lines = ["📊 Soros 모의투자 주간 보고", ""]
    if latest:
        total = int(latest["total_value"])
        ret = (total - initial) / initial * 100
        week_delta = (
            total - int(week_start["total_value"]) if week_start else 0
        )
        lines.append(
            f"총자산 {total:,}원 (누적 {ret:+.2f}%)"
        )
        lines.append(
            f"주간 손익 {week_delta:+,}원 · 현금 {int(latest['cash']):,}원 · 보유 {latest['n_positions']}종목"
        )
    else:
        lines.append("아직 스냅샷이 없습니다.")
    lines.append("")

    if positions:
        lines.append("— 보유 현황 —")
        for p in sorted(positions, key=lambda x: -x["qty"] * x["avg_price"]):
            t = p["ticker"]
            close = closes.get(t, (None, int(p["avg_price"])))[1]
            pnl_pct = (close - int(p["avg_price"])) / int(p["avg_price"]) * 100
            lines.append(
                f"{names.get(t, t)}: {p['qty']}주 평단 {int(p['avg_price']):,} → {close:,} ({pnl_pct:+.1f}%)"
            )
        lines.append("")

    lines.append(f"— 주간 거래 {len(trades)}건 —")
    for tr in trades[:15]:
        nm = names.get(tr["ticker"], tr["ticker"])
        if tr["side"] == "buy":
            lines.append(
                f"{tr['trade_date'][5:]} 매수 {nm} {tr['qty']}주 @{int(tr['price']):,}"
            )
        else:
            lines.append(
                f"{tr['trade_date'][5:]} 매도 {nm} {tr['qty']}주 @{int(tr['price']):,} (손익 {int(tr['realized_pnl'] or 0):+,})"
            )
    if len(trades) > 15:
        lines.append(f"… 외 {len(trades) - 15}건")
    lines.append("")
    lines.append("※ 가상 자금 시뮬레이션 결과이며 매매 권유가 아닙니다.")
    msg = "\n".join(lines)

    if send:
        token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
        chat = os.environ.get("TELEGRAM_ADMIN_CHAT_ID", "")
        if token and chat:
            httpx.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                data={"chat_id": chat, "text": msg},
                timeout=15,
            )
            log.info("[paper_bot] weekly report sent")
        else:
            log.warning("[paper_bot] telegram secrets absent — report not sent")
    return msg


# ─── CLI ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--reset", action="store_true")
    p.add_argument("--capital", type=int, default=None)
    p.add_argument("--weekly-report", action="store_true")
    p.add_argument("--no-send", action="store_true")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    sb = get_admin_client()
    if args.reset:
        reset(sb, args.capital)
    elif args.weekly_report:
        print(weekly_report(sb, send=not args.no_send))
    else:
        print(run_cycle(sb))
