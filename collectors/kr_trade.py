"""KR trade collector — 관세청 품목별(HS) 월간 수출입실적.

Source: data.go.kr 관세청_품목별 수출입실적(GW)
  endpoint  http://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList
  params    serviceKey, strtYymm, endYymm, hsSgn (HS code, 2/4/6/10-digit)
  cadence   monthly; previous month finalized ~15th of current month

Feeds the 9th scoring factor (수출입 동향). Evidence from our own
validation (2026-06): export YoY is a COINCIDENT confirmation signal
(ρ≈+0.4 same-month vs 삼성전자/현대차), not a predictor — hence the
deliberately small default weight (0.04) in cognition/scorer.py.

HS groups tracked map to the 5 watchlist sectors:
  반도체      → 8542 (집적회로) + 8541 (다이오드/트랜지스터)
  2차전지     → 8507 (축전지)
  자동차      → 8703 (승용차) + 8708 (부품)
  바이오/헬스  → 30   (의약품, 2-digit chapter)
  인터넷/AI   → (수출 무관 — factor stays NEUTRAL for this sector)

Requires env DATA_GO_KR_API_KEY (free, auto-approved dev key from
https://www.data.go.kr/data/15101609/openapi.do). When the key is
absent the collector logs and exits 0 so the daily pipeline keeps
its green/red semantics for genuine failures only.

Per ABSOLUTE RULE B, raw responses pass through validation here
(collectors fetch + shape only; no business logic) and the scorer
treats missing periods as NEUTRAL.
"""
from __future__ import annotations

import logging
import os
import time
import xml.etree.ElementTree as ET
from typing import Any

import httpx

log = logging.getLogger("collectors.kr_trade")

ENDPOINT = "http://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList"

#: HS codes per watchlist sector (sector label → list of HS prefixes).
SECTOR_HS: dict[str, list[str]] = {
    "반도체": ["8542", "8541"],
    "2차전지": ["8507"],
    "자동차": ["8703", "8708"],
    "바이오/헬스": ["30"],
    # 인터넷/AI intentionally absent — domestic/services revenue,
    # exports are not a meaningful driver. Scorer returns NEUTRAL.
}

#: Flat list of HS codes to collect.
ALL_HS: list[str] = sorted({hs for codes in SECTOR_HS.values() for hs in codes})

#: Self-pacing between API calls (the gateway rate-limits aggressively).
PACE_SECONDS = 0.5


def _parse_int(text: str | None) -> int | None:
    if text is None:
        return None
    try:
        return int(text.replace(",", "").strip())
    except (ValueError, AttributeError):
        return None


def fetch_hs_monthly(
    client: httpx.Client,
    api_key: str,
    hs_code: str,
    start_yymm: str,
    end_yymm: str,
) -> list[dict[str, Any]]:
    """Fetch monthly export/import rows for one HS code.

    Returns rows shaped for kr_trade_stats. Empty list on any error
    (logged) — a single HS failure must not tank the run.
    The API answers XML; each <item> carries year (YYYY.MM), expDlr,
    impDlr, balPayments.
    """
    try:
        resp = client.get(
            ENDPOINT,
            params={
                "serviceKey": api_key,
                "strtYymm": start_yymm,
                "endYymm": end_yymm,
                "hsSgn": hs_code,
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        root = ET.fromstring(resp.text)
        # data.go.kr error responses use a different envelope.
        err = root.findtext(".//returnAuthMsg") or root.findtext(".//errMsg")
        result_code = root.findtext(".//resultCode")
        if err or (result_code not in (None, "00")):
            log.warning("[kr_trade] %s API error: %s (code=%s)", hs_code, err, result_code)
            return []
        rows: list[dict[str, Any]] = []
        for item in root.iter("item"):
            period_raw = (item.findtext("year") or "").strip()  # 'YYYY.MM' or '총계'
            if "." not in period_raw:
                continue  # skip the 총계 aggregate row
            period = period_raw.replace(".", "-")[:7]
            export_usd = _parse_int(item.findtext("expDlr"))
            import_usd = _parse_int(item.findtext("impDlr"))
            balance = _parse_int(item.findtext("balPayments"))
            if export_usd is None:
                continue
            rows.append(
                {
                    "hs_code": hs_code,
                    "period": period,
                    "export_usd": export_usd,
                    "import_usd": import_usd,
                    "trade_balance": balance,
                }
            )
        return rows
    except Exception as exc:
        log.warning("[kr_trade] %s fetch failed: %s", hs_code, exc)
        return []


def compute_yoy(rows: list[dict[str, Any]]) -> None:
    """Fill export_yoy in place: (v[m] - v[m-12]) / v[m-12] * 100.

    Operates per hs_code. Periods whose 12-months-ago base is missing
    or zero keep export_yoy = None (refinery rule: never fabricate).
    """
    by_key = {(r["hs_code"], r["period"]): r for r in rows}
    for r in rows:
        y, m = int(r["period"][:4]), int(r["period"][5:7])
        base_period = f"{y - 1}-{m:02d}"
        base = by_key.get((r["hs_code"], base_period))
        if base and base.get("export_usd"):
            r["export_yoy"] = round(
                (r["export_usd"] - base["export_usd"]) / base["export_usd"] * 100, 2
            )
        else:
            r["export_yoy"] = None


def upsert_trade_rows(supabase, rows: list[dict[str, Any]]) -> int:
    """Upsert into kr_trade_stats on (hs_code, period). Returns count."""
    if not rows:
        return 0
    supabase.table("kr_trade_stats").upsert(
        rows, on_conflict="hs_code,period"
    ).execute()
    return len(rows)


def collect_and_persist(
    supabase,
    *,
    start_yymm: str,
    end_yymm: str,
    pace_seconds: float = PACE_SECONDS,
) -> dict[str, int]:
    """Fetch all sector HS codes for the window and persist.

    To compute YoY for the requested window we widen the fetch start
    by 12 months, then store the full fetched range (cheap, and the
    extra history is exactly what the scorer's percentile rank needs).
    """
    api_key = os.environ.get("DATA_GO_KR_API_KEY", "").strip()
    if not api_key:
        log.warning("[kr_trade] DATA_GO_KR_API_KEY not set — skipping (factor stays NEUTRAL)")
        return {"hs_codes": 0, "rows": 0, "skipped_no_key": 1}

    y, m = int(start_yymm[:4]), int(start_yymm[4:6])
    widened_start = f"{y - 1}{m:02d}"

    all_rows: list[dict[str, Any]] = []
    with httpx.Client() as client:
        for i, hs in enumerate(ALL_HS):
            if i > 0:
                time.sleep(pace_seconds)
            all_rows.extend(
                fetch_hs_monthly(client, api_key, hs, widened_start, end_yymm)
            )
    compute_yoy(all_rows)
    n = upsert_trade_rows(supabase, all_rows)
    return {"hs_codes": len(ALL_HS), "rows": n, "skipped_no_key": 0}


# ─── CLI ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    from datetime import date

    from db.supabase_client import get_admin_client

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--start", default=None, help="YYYYMM (default: 36 months back)")
    p.add_argument("--end", default=None, help="YYYYMM (default: current month)")
    args = p.parse_args()

    today = date.today()
    end = args.end or f"{today.year}{today.month:02d}"
    if args.start:
        start = args.start
    else:
        sy, sm = today.year - 3, today.month
        start = f"{sy}{sm:02d}"

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    summary = collect_and_persist(get_admin_client(), start_yymm=start, end_yymm=end)
    print(f"[kr_trade] {summary}")
