"""KRX 공매도 collector — 거래량(T+1) + 잔고(T+2), watchlist 전 종목.

Needs a KRX datacenter login (KRX_ID / KRX_PW env) — pykrx handles the
session. Skips cleanly (exit 0 + warning) when credentials are absent
or login fails (e.g., CD007 lockout), so the daily pipeline's green/red
stays meaningful; the silent-failure Telegram alert covers hard errors.

Evidence basis (Lee & Wang SSRN; KAIST/PBFJ NAT anomaly): heavy short
activity — especially rising short BALANCE — predicts short-run
underperformance in KR. Consumed by executor/position_sizing as a
conviction dampener on buys (never as a standalone buy/sell signal).
"""
from __future__ import annotations

import logging
import os
import time
from datetime import date as Date
from datetime import timedelta
from typing import Any

log = logging.getLogger("collectors.kr_short")

CATCHUP_DAYS = 10
PACE_SECONDS = 0.4


def _login_ok() -> bool:
    if not (os.environ.get("KRX_ID") and os.environ.get("KRX_PW")):
        log.warning("[kr_short] KRX_ID/KRX_PW not set — skipping")
        return False
    try:
        from pykrx.website.comm.auth import get_auth_session

        return get_auth_session() is not None
    except Exception as exc:
        log.warning("[kr_short] KRX login failed (%s) — skipping", exc)
        return False


def fetch_ticker_short(ticker: str, bgn: str, end: str) -> list[dict[str, Any]]:
    """Merge volume (T+1) and balance (T+2) frames into row dicts.

    Empty list on any per-ticker failure — one name must not tank the run.
    """
    rows: dict[str, dict[str, Any]] = {}
    try:
        from pykrx import stock

        vol = stock.get_shorting_volume_by_date(bgn, end, ticker)
        for idx, r in vol.iterrows():
            d = idx.strftime("%Y-%m-%d")
            rows[d] = {
                "ticker": ticker,
                "date": d,
                "short_volume": int(r.get("공매도", 0) or 0),
                "total_volume": int(r.get("매수", 0) or 0),
                "short_ratio": float(r.get("비중", 0) or 0),
            }
    except Exception as exc:
        log.warning("[kr_short] %s volume fetch failed: %s", ticker, exc)
    try:
        from pykrx import stock

        bal = stock.get_shorting_balance_by_date(bgn, end, ticker)
        for idx, r in bal.iterrows():
            d = idx.strftime("%Y-%m-%d")
            row = rows.setdefault(d, {"ticker": ticker, "date": d})
            row["balance_qty"] = int(r.get("공매도잔고", 0) or 0)
            row["balance_ratio"] = float(r.get("비중", 0) or 0)
    except Exception as exc:
        log.warning("[kr_short] %s balance fetch failed: %s", ticker, exc)
    return list(rows.values())


def collect_and_persist(sb, *, days: int = CATCHUP_DAYS) -> dict[str, int]:
    if not _login_ok():
        return {"tickers": 0, "rows": 0, "skipped_no_login": 1}

    tickers = sorted(
        r["ticker"]
        for r in (
            sb.table("stocks").select("ticker").eq("is_watchlist", True).execute().data
            or []
        )
        if r["ticker"].isdigit()  # pykrx needs pure-numeric KRX codes
    )
    end = Date.today()
    bgn = end - timedelta(days=days)
    bgn_s, end_s = bgn.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    total = 0
    for i, t in enumerate(tickers):
        if i > 0:
            time.sleep(PACE_SECONDS)
        rows = fetch_ticker_short(t, bgn_s, end_s)
        if rows:
            sb.table("kr_short_selling").upsert(
                rows, on_conflict="ticker,date"
            ).execute()
            total += len(rows)
    log.info("[kr_short] %d tickers, %d rows (%s..%s)", len(tickers), total, bgn_s, end_s)
    return {"tickers": len(tickers), "rows": total, "skipped_no_login": 0}


if __name__ == "__main__":
    import argparse

    from db.supabase_client import get_admin_client

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--days", type=int, default=CATCHUP_DAYS)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    print(collect_and_persist(get_admin_client(), days=args.days))
