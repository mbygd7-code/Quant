"""Backfill foreign/institution net-buy into korea_market from NAVER.

korea_market.foreign_net_buy / institution_net_buy had ZERO rows ever:
the pykrx investor-flow endpoint silently started requiring a KRX
datacenter login, so the collector's supply/demand step failed on every
ticker since launch (at debug log level — invisible). The collector now
uses NAVER's investor-trend API (collectors/krx.py); this script
backfills the last ~60 trading days for the whole watchlist so Shiller's
foreign-flow component and the new regressor features have history on
day one.

Value approximation: NAVER reports net-buy QUANTITY (shares); we store
quantity × that day's close (KRW), matching the schema and Shiller's
±5조 saturation scale.

Usage:
    python -m scripts.backfill_investor_trend [--days 60] [--pace 0.4]
"""
from __future__ import annotations

import argparse
import logging
import time

from collectors.krx import _naver_investor_trend, _parse_signed_int
from db.supabase_client import get_admin_client

log = logging.getLogger("scripts.backfill_investor_trend")


def backfill(days: int = 60, pace: float = 0.4) -> dict[str, int]:
    sb = get_admin_client()
    tickers = sorted(
        r["ticker"]
        for r in (
            sb.table("stocks").select("ticker").eq("is_watchlist", True).execute().data
            or []
        )
    )
    updated = 0
    skipped = 0
    failed_tickers: list[str] = []
    for i, ticker in enumerate(tickers):
        if i > 0:
            time.sleep(pace)
        try:
            rows = _naver_investor_trend(ticker, page_size=days)
        except Exception as exc:
            log.warning("[backfill] %s trend fetch failed: %s", ticker, exc)
            failed_tickers.append(ticker)
            continue
        for r in rows:
            ymd = r.get("bizdate") or ""
            if len(ymd) != 8:
                continue
            date_iso = f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"
            close = _parse_signed_int(r.get("closePrice"))
            frgn = _parse_signed_int(r.get("foreignerPureBuyQuant"))
            organ = _parse_signed_int(r.get("organPureBuyQuant"))
            if close is None or (frgn is None and organ is None):
                skipped += 1
                continue
            patch = {}
            if frgn is not None:
                patch["foreign_net_buy"] = frgn * close
            if organ is not None:
                patch["institution_net_buy"] = organ * close
            # UPDATE only — never insert price rows from this source;
            # OHLCV remains the responsibility of the main collector.
            res = (
                sb.table("korea_market")
                .update(patch)
                .eq("ticker", ticker)
                .eq("date", date_iso)
                .execute()
            )
            updated += len(res.data or [])
        print(f"[{i + 1}/{len(tickers)}] {ticker} done")
    return {
        "tickers": len(tickers),
        "rows_updated": updated,
        "rows_skipped": skipped,
        "failed_tickers": len(failed_tickers),
    }


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--days", type=int, default=60)
    p.add_argument("--pace", type=float, default=0.4)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    print(backfill(days=args.days, pace=args.pace))
