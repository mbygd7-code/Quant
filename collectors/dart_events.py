"""DART disclosure-event collector — watchlist 공시를 매일 수집.

Source: DART OpenAPI list.json (공시검색)
  https://opendart.fss.or.kr/api/list.json
  params: crtfc_key, corp_code (8-digit, from kr_corp_codes),
          bgn_de/end_de (YYYYMMDD), page_count ≤ 100

Cadence: daily pipeline, trailing CATCHUP_DAYS window so a missed run
self-heals. ~61 corp_codes × 1 request — well inside DART's 20k/day cap.

Events are categorized by report_nm keywords (CATEGORY_RULES). The
stream feeds:
  · Taleb — 잠정실적 등 이벤트 공시 발생 = 불확실성 컨텍스트
  · 리포트/UI — 종목별 최근 공시 근거
  · 향후 이벤트 드리븐 시그널의 원천 데이터

Per ABSOLUTE RULE B: fetch + shape only; refinery semantics are the
keyword categorizer (pure, tested) and rcept_no natural-key dedup.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import date as Date
from datetime import timedelta
from typing import Any

import httpx

log = logging.getLogger("collectors.dart_events")

ENDPOINT = "https://opendart.fss.or.kr/api/list.json"
VIEWER = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo="
PACE_SECONDS = 0.15
CATCHUP_DAYS = 7

#: report_nm keyword → category. First match wins (order matters:
#: '잠정' before the generic 보고서 buckets).
CATEGORY_RULES: tuple[tuple[str, str], ...] = (
    ("영업(잠정)실적", "잠정실적"),
    ("잠정실적", "잠정실적"),
    ("연결재무제표기준영업", "잠정실적"),
    ("분기보고서", "정기보고서"),
    ("반기보고서", "정기보고서"),
    ("사업보고서", "정기보고서"),
    ("자기주식", "자사주"),
    ("유상증자", "증자/감자"),
    ("무상증자", "증자/감자"),
    ("감자", "증자/감자"),
    ("전환사채", "CB/BW"),
    ("신주인수권", "CB/BW"),
    ("교환사채", "CB/BW"),
    ("단일판매", "공급계약"),
    ("공급계약", "공급계약"),
    ("수주", "공급계약"),
    ("소송", "소송"),
    ("최대주주", "지배구조"),
    ("합병", "지배구조"),
    ("분할", "지배구조"),
    ("주식분할", "지배구조"),
    ("배당", "배당"),
    ("임상", "임상/허가"),
    ("품목허가", "임상/허가"),
)


def categorize(report_nm: str) -> str:
    name = (report_nm or "").strip()
    for kw, cat in CATEGORY_RULES:
        if kw in name:
            return cat
    return "기타"


def fetch_corp_disclosures(
    client: httpx.Client,
    api_key: str,
    corp_code: str,
    ticker: str,
    bgn_de: str,
    end_de: str,
) -> list[dict[str, Any]]:
    """One corp's disclosures in the window → dart_disclosures rows.

    Empty list on any error (logged) — one corp must not tank the run.
    A single page of 100 covers any realistic 7-day window per corp.
    """
    try:
        resp = client.get(
            ENDPOINT,
            params={
                "crtfc_key": api_key,
                "corp_code": corp_code,
                "bgn_de": bgn_de,
                "end_de": end_de,
                "page_count": 100,
            },
            timeout=15.0,
        )
        resp.raise_for_status()
        body = resp.json()
        status = body.get("status")
        if status == "013":  # no data in window — normal, not an error
            return []
        if status != "000":
            log.warning("[dart_events] %s API status=%s msg=%s",
                        ticker, status, body.get("message"))
            return []
        rows: list[dict[str, Any]] = []
        for item in body.get("list", []) or []:
            rcept_no = (item.get("rcept_no") or "").strip()
            report_nm = (item.get("report_nm") or "").strip()
            rcept_dt = (item.get("rcept_dt") or "").strip()
            if not rcept_no or not report_nm or len(rcept_dt) != 8:
                continue
            rows.append(
                {
                    "rcept_no": rcept_no,
                    "ticker": ticker,
                    "corp_name": (item.get("corp_name") or "").strip()[:100],
                    "report_nm": report_nm[:300],
                    "category": categorize(report_nm),
                    "rcept_dt": f"{rcept_dt[:4]}-{rcept_dt[4:6]}-{rcept_dt[6:8]}",
                    "url": VIEWER + rcept_no,
                }
            )
        return rows
    except Exception as exc:
        log.warning("[dart_events] %s fetch failed: %s", ticker, exc)
        return []


def collect_and_persist(sb, *, days: int = CATCHUP_DAYS) -> dict[str, int]:
    api_key = os.environ.get("DART_API_KEY", "").strip()
    if not api_key:
        log.warning("[dart_events] DART_API_KEY not set — skipping")
        return {"corps": 0, "rows": 0, "skipped_no_key": 1}

    mappings = (
        sb.table("kr_corp_codes")
        .select("ticker, corp_code")
        .execute()
        .data
        or []
    )
    watchlist = {
        r["ticker"]
        for r in (
            sb.table("stocks").select("ticker").eq("is_watchlist", True).execute().data
            or []
        )
    }
    pairs = [m for m in mappings if m["ticker"] in watchlist]

    end = Date.today()
    bgn = end - timedelta(days=days)
    bgn_de, end_de = bgn.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    all_rows: list[dict[str, Any]] = []
    with httpx.Client() as client:
        for i, m in enumerate(pairs):
            if i > 0:
                time.sleep(PACE_SECONDS)
            all_rows.extend(
                fetch_corp_disclosures(
                    client, api_key, m["corp_code"], m["ticker"], bgn_de, end_de
                )
            )

    inserted = 0
    if all_rows:
        # rcept_no natural-key dedup; never overwrite (immutable events).
        sb.table("dart_disclosures").upsert(
            all_rows, on_conflict="rcept_no", ignore_duplicates=True
        ).execute()
        inserted = len(all_rows)
    log.info("[dart_events] corps=%d rows=%d (%s..%s)",
             len(pairs), inserted, bgn_de, end_de)
    return {"corps": len(pairs), "rows": inserted, "skipped_no_key": 0}


if __name__ == "__main__":
    import argparse

    from db.supabase_client import get_admin_client

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--days", type=int, default=CATCHUP_DAYS)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    print(collect_and_persist(get_admin_client(), days=args.days))
