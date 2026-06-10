"""Soros paper-trading bot — the live usability audit of the signals.

A single global virtual portfolio (paper_config singleton, default 1억원)
that trades the Soros consensus automatically after every agents cycle.

ORDER → NEXT-OPEN FILL (the honest execution model):
  Signals arrive pre-market (06:00). The first price a real trader can
  obtain is the 09:00 open of the SAME day — so the bot places pending
  orders at signal time, and they fill at the signal day's OPEN, which
  lands in korea_market the next morning. Fills are therefore confirmed
  one pipeline run later, at prices that were actually obtainable.
  (The previous version filled at the latest close in DB = yesterday's
  close — a pre-signal price nobody could trade, and systematically
  flattering because our signals react to the US overnight session.)

  · BUY orders reserve cash (budget) at placement; unspent remainder is
    refunded at fill, everything on cancellation (7-day stale cancel).
  · SELL orders pin the position's quantity; the position stays valued
    until the fill lands.

Rules per cycle:
  BUY  — top fresh final_signals (STRONG_BUY first, then BUY, by
         weighted_score) into equal slots (equity / max_positions),
         while free cash allows; skip names held or already pending.
  SELL — full exit order when a held name's latest grade is CAUTION/RISK.

Realism: open-price fills ±0.05% adverse slippage, 0.015% commission per
side, 0.15% sell tax (2025~), integer shares, no leverage, cash ≥ 0.

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
MIN_CASH_FRACTION = 0.95    # need ≥ slot×this in free cash to order
ORDER_STALE_DAYS = 7        # cancel pending orders older than this


# ─── Small reads ───────────────────────────────────────────────────


def _config(sb) -> dict:
    rows = sb.table("paper_config").select("*").eq("id", 1).execute().data
    if not rows:
        sb.table("paper_config").insert({"id": 1}).execute()
        rows = sb.table("paper_config").select("*").eq("id", 1).execute().data
    return rows[0]


def _set_cash(sb, cash: int) -> None:
    sb.table("paper_config").update(
        {"cash": cash, "updated_at": datetime.utcnow().isoformat() + "Z"}
    ).eq("id", 1).execute()


def _latest_closes(sb, tickers: list[str]) -> dict[str, int]:
    if not tickers:
        return {}
    out: dict[str, int] = {}
    rows = fetch_all(
        sb.table("korea_market")
        .select("ticker, date, close")
        .in_("ticker", tickers)
        .not_.is_("close", "null")
        .order("date", desc=True)
    )
    for r in rows:
        if r["ticker"] not in out:
            out[r["ticker"]] = int(r["close"])
    return out


def _first_open_on_or_after(sb, ticker: str, date_iso: str) -> tuple[str, int] | None:
    """First korea_market (date, open) with date ≥ date_iso — the fill bar."""
    rows = (
        sb.table("korea_market")
        .select("date, open")
        .eq("ticker", ticker)
        .gte("date", date_iso)
        .not_.is_("open", "null")
        .order("date")
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return None
    return rows[0]["date"], int(rows[0]["open"])


def _latest_signals(sb, max_age_days: int = SIGNAL_FRESH_DAYS) -> dict[str, dict]:
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


def _pending_orders(sb) -> list[dict]:
    return (
        sb.table("paper_bot_orders")
        .select("*")
        .eq("status", "pending")
        .order("id")
        .execute()
        .data
        or []
    )


def _names(sb, tickers: list[str]) -> dict[str, str]:
    if not tickers:
        return {}
    rows = (
        sb.table("stocks").select("ticker, name").in_("ticker", tickers).execute().data
        or []
    )
    return {r["ticker"]: r.get("name") or r["ticker"] for r in rows}


# ─── Phase 1: fill pending orders at their signal day's open ───────


def fill_pending(sb, today: Date | None = None) -> dict[str, int]:
    today = today or Date.today()
    cfg = _config(sb)
    cash = int(cfg["cash"])
    filled = 0
    cancelled = 0

    for order in _pending_orders(sb):
        bar = _first_open_on_or_after(sb, order["ticker"], order["order_date"])
        if bar is None:
            # Open not collected yet (or suspended). Cancel when stale.
            age = (today - Date.fromisoformat(order["order_date"])).days
            if age > ORDER_STALE_DAYS:
                if order["side"] == "buy" and order.get("budget"):
                    cash += int(order["budget"])  # refund reservation
                sb.table("paper_bot_orders").update(
                    {"status": "cancelled", "cancel_reason": f"{age}일 미체결 (시가 데이터 없음)"}
                ).eq("id", order["id"]).execute()
                cancelled += 1
            continue

        fill_date, open_px = bar

        if order["side"] == "buy":
            px = round(open_px * (1 + SLIPPAGE))
            budget = int(order["budget"] or 0)
            qty = math.floor(budget / (px * (1 + COMMISSION_RATE)))
            if qty <= 0:
                cash += budget
                sb.table("paper_bot_orders").update(
                    {"status": "cancelled", "cancel_reason": "예산 부족 (시가 급등)"}
                ).eq("id", order["id"]).execute()
                cancelled += 1
                continue
            gross = qty * px
            fee = round(gross * COMMISSION_RATE)
            spent = gross + fee
            cash += budget - spent  # refund the unspent remainder
            avg = round(spent / qty)  # cost basis incl. buy fee
            # Merge if a position somehow exists (guarded at placement,
            # but a manual insert shouldn't corrupt the books).
            existing = (
                sb.table("paper_bot_positions")
                .select("qty, avg_price")
                .eq("ticker", order["ticker"])
                .execute()
                .data
                or []
            )
            if existing:
                old_qty = int(existing[0]["qty"])
                old_avg = int(existing[0]["avg_price"])
                new_qty = old_qty + qty
                avg = round((old_qty * old_avg + spent) / new_qty)
                qty_total = new_qty
            else:
                qty_total = qty
            sb.table("paper_bot_positions").upsert(
                {
                    "ticker": order["ticker"],
                    "qty": qty_total,
                    "avg_price": avg,
                    "opened_at": fill_date,
                    "updated_at": datetime.utcnow().isoformat() + "Z",
                }
            ).execute()
            sb.table("paper_bot_trades").insert(
                {
                    "trade_date": fill_date,
                    "ticker": order["ticker"],
                    "side": "buy",
                    "qty": qty,
                    "price": px,
                    "amount": gross,
                    "fee": fee,
                    "tax": 0,
                    "signal_grade": order.get("signal_grade"),
                    "weighted_score": order.get("weighted_score"),
                    "reason": order.get("reason"),
                    "realized_pnl": None,
                }
            ).execute()
        else:  # sell
            px = round(open_px * (1 - SLIPPAGE))
            qty = int(order["qty"] or 0)
            pos = (
                sb.table("paper_bot_positions")
                .select("qty, avg_price")
                .eq("ticker", order["ticker"])
                .execute()
                .data
                or []
            )
            if not pos or qty <= 0:
                sb.table("paper_bot_orders").update(
                    {"status": "cancelled", "cancel_reason": "보유 포지션 없음"}
                ).eq("id", order["id"]).execute()
                cancelled += 1
                continue
            qty = min(qty, int(pos[0]["qty"]))
            gross = qty * px
            fee = round(gross * COMMISSION_RATE)
            tax = round(gross * SELL_TAX_RATE)
            net = gross - fee - tax
            pnl = net - qty * int(pos[0]["avg_price"])
            cash += net
            remaining = int(pos[0]["qty"]) - qty
            if remaining > 0:
                sb.table("paper_bot_positions").update(
                    {"qty": remaining, "updated_at": datetime.utcnow().isoformat() + "Z"}
                ).eq("ticker", order["ticker"]).execute()
            else:
                sb.table("paper_bot_positions").delete().eq(
                    "ticker", order["ticker"]
                ).execute()
            sb.table("paper_bot_trades").insert(
                {
                    "trade_date": fill_date,
                    "ticker": order["ticker"],
                    "side": "sell",
                    "qty": qty,
                    "price": px,
                    "amount": gross,
                    "fee": fee,
                    "tax": tax,
                    "signal_grade": order.get("signal_grade"),
                    "weighted_score": order.get("weighted_score"),
                    "reason": order.get("reason"),
                    "realized_pnl": pnl,
                }
            ).execute()

        sb.table("paper_bot_orders").update(
            {"status": "filled", "fill_date": fill_date, "fill_price": px}
        ).eq("id", order["id"]).execute()
        filled += 1

    _set_cash(sb, cash)
    return {"filled": filled, "cancelled": cancelled}


# ─── Phase 2: place today's orders from fresh signals ──────────────


def place_orders(sb, today: Date | None = None) -> dict[str, int]:
    today = today or Date.today()
    cfg = _config(sb)
    cash = int(cfg["cash"])
    max_pos = int(cfg["max_positions"])

    positions = {
        p["ticker"]: p
        for p in (sb.table("paper_bot_positions").select("*").execute().data or [])
    }
    pending = _pending_orders(sb)
    pending_buy = {o["ticker"] for o in pending if o["side"] == "buy"}
    pending_sell = {o["ticker"] for o in pending if o["side"] == "sell"}
    signals = _latest_signals(sb)
    closes = _latest_closes(sb, sorted(set(positions) | set(signals)))

    placed_sell = 0
    placed_buy = 0

    # SELL orders: held names whose latest grade turned negative.
    for ticker, pos in positions.items():
        if ticker in pending_sell:
            continue
        sig = signals.get(ticker)
        if not sig or sig["signal_grade"] not in SELL_GRADES:
            continue
        sb.table("paper_bot_orders").insert(
            {
                "order_date": today.isoformat(),
                "ticker": ticker,
                "side": "sell",
                "qty": int(pos["qty"]),
                "signal_grade": sig["signal_grade"],
                "weighted_score": sig.get("weighted_score"),
                "reason": f"신호 하향({sig['signal_grade']}) 전량 청산 — 시가 체결 대기",
            }
        ).execute()
        pending_sell.add(ticker)
        placed_sell += 1

    # BUY orders: best fresh signals into open slots; reserve cash.
    invested = sum(
        int(p["qty"]) * closes.get(t, int(p["avg_price"]))
        for t, p in positions.items()
    )
    reserved = sum(int(o["budget"] or 0) for o in pending if o["side"] == "buy")
    equity = cash + reserved + invested
    slot = equity // max_pos if max_pos > 0 else 0
    slots_used = len(positions) + len(pending_buy)

    candidates = sorted(
        (
            s
            for t, s in signals.items()
            if s["signal_grade"] in BUY_GRADES
            and t not in positions
            and t not in pending_buy
            and t not in pending_sell
            and t in closes
        ),
        key=lambda s: (
            0 if s["signal_grade"] == "STRONG_BUY" else 1,
            -(s.get("weighted_score") or 0),
        ),
    )
    for sig in candidates:
        if slots_used >= max_pos:
            break
        if cash < slot * MIN_CASH_FRACTION:
            break
        budget = int(min(slot, cash))
        cash -= budget  # reserve until fill/cancel
        sb.table("paper_bot_orders").insert(
            {
                "order_date": today.isoformat(),
                "ticker": sig["ticker"],
                "side": "buy",
                "budget": budget,
                "signal_grade": sig["signal_grade"],
                "weighted_score": sig.get("weighted_score"),
                "reason": f"{sig['signal_grade']} 신호 진입 (점수 {sig.get('weighted_score')}) — 시가 체결 대기",
            }
        ).execute()
        slots_used += 1
        placed_buy += 1

    _set_cash(sb, cash)
    return {"buy_orders": placed_buy, "sell_orders": placed_sell}


# ─── Snapshot + cycle entrypoint ───────────────────────────────────


def write_snapshot(sb, today: Date | None = None) -> dict:
    today = today or Date.today()
    cfg = _config(sb)
    cash = int(cfg["cash"])
    initial = int(cfg["initial_capital"])

    positions = sb.table("paper_bot_positions").select("*").execute().data or []
    closes = _latest_closes(sb, [p["ticker"] for p in positions])
    invested = 0
    unrealized = 0
    for p in positions:
        close = closes.get(p["ticker"], int(p["avg_price"]))
        invested += int(p["qty"]) * close
        unrealized += int(p["qty"]) * (close - int(p["avg_price"]))
    reserved = sum(
        int(o["budget"] or 0) for o in _pending_orders(sb) if o["side"] == "buy"
    )
    realized_cum = sum(
        int(r["realized_pnl"] or 0)
        for r in fetch_all(
            sb.table("paper_bot_trades").select("realized_pnl").eq("side", "sell")
        )
    )
    total = cash + reserved + invested
    sb.table("paper_bot_snapshots").upsert(
        {
            "snap_date": today.isoformat(),
            "total_value": total,
            # snapshot cash includes buy reservations — it's still cash,
            # just earmarked for pending orders.
            "cash": cash + reserved,
            "invested": invested,
            "unrealized_pnl": unrealized,
            "realized_pnl_cum": realized_cum,
            "ret_pct": round((total - initial) / initial * 100, 4),
            "n_positions": len(positions),
        }
    ).execute()
    return {
        "total_value": total,
        "ret_pct": round((total - initial) / initial * 100, 2),
        "positions": len(positions),
        "reserved": reserved,
    }


def run_cycle(sb, today: Date | None = None) -> dict:
    """One daily run: fill yesterday's orders, place today's, snapshot."""
    check_execution_mode()
    today = today or Date.today()
    fills = fill_pending(sb, today)
    orders = place_orders(sb, today)
    snap = write_snapshot(sb, today)
    summary = {**fills, **orders, **snap}
    log.info("[paper_bot] %s", summary)
    return summary


# ─── Reset (capital edit) ──────────────────────────────────────────


def reset(sb, initial_capital: int | None = None) -> None:
    """Wipe the bot portfolio and restart from `initial_capital`."""
    cfg = _config(sb)
    capital = int(initial_capital or cfg["initial_capital"])
    sb.table("paper_bot_orders").delete().neq("id", 0).execute()
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

    snaps = fetch_all(sb.table("paper_bot_snapshots").select("*").order("snap_date"))
    latest = snaps[-1] if snaps else None
    week_start = next((s for s in snaps if s["snap_date"] >= week_ago), None)

    trades = fetch_all(
        sb.table("paper_bot_trades")
        .select("*")
        .gte("trade_date", week_ago)
        .order("trade_date")
    )
    pending = _pending_orders(sb)
    positions = sb.table("paper_bot_positions").select("*").execute().data or []
    closes = _latest_closes(sb, [p["ticker"] for p in positions])
    names = _names(
        sb,
        [p["ticker"] for p in positions]
        + [t["ticker"] for t in trades]
        + [o["ticker"] for o in pending],
    )

    lines = ["📊 Soros 모의투자 주간 보고", ""]
    if latest:
        total = int(latest["total_value"])
        ret = (total - initial) / initial * 100
        week_delta = total - int(week_start["total_value"]) if week_start else 0
        lines.append(f"총자산 {total:,}원 (누적 {ret:+.2f}%)")
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
            close = closes.get(t, int(p["avg_price"]))
            pnl_pct = (close - int(p["avg_price"])) / int(p["avg_price"]) * 100
            lines.append(
                f"{names.get(t, t)}: {p['qty']}주 평단 {int(p['avg_price']):,} → {close:,} ({pnl_pct:+.1f}%)"
            )
        lines.append("")

    if pending:
        lines.append(f"— 체결 대기 {len(pending)}건 (다음 시가) —")
        for o in pending[:8]:
            side = "매수" if o["side"] == "buy" else "매도"
            lines.append(f"{o['order_date'][5:]} {side} {names.get(o['ticker'], o['ticker'])}")
        lines.append("")

    lines.append(f"— 주간 체결 {len(trades)}건 —")
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
    lines.append("※ 가상 자금 시뮬레이션(시가 체결 가정) 결과이며 매매 권유가 아닙니다.")
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
