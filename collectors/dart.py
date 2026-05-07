"""DART (전자공시) collector — KR corp codes + quarterly financials.

DART OpenAPI free tier: 1000 requests/day, no per-minute limit advertised.
We pace at 0.5s between calls to stay polite.

Endpoints used:
  - /api/corpCode.xml   — bulk download, ticker (stock_code) → corp_code map
  - /api/fnlttSinglAcnt.json — single-company main accounts (Q/H/Y)

Cadence:
  - corp_codes: re-fetch monthly (changes are rare — IPOs, name changes)
  - financials: re-fetch when each quarterly disclosure window opens
                (45 / 90 / 135 / 90 days post-period for Q1/H/Q3/Y)

Auth: DART_API_KEY env var (40-char hex).
"""
from __future__ import annotations

import io
import logging
import os
import time
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

log = logging.getLogger("collectors.dart")

DART_BASE = "https://opendart.fss.or.kr/api"

# Quarterly report codes per DART spec
# 11013 = 1분기, 11012 = 반기 (누적 6개월), 11014 = 3분기, 11011 = 사업보고서(연간)
REPORT_CODES = {
    "Q1": "11013",
    "H1": "11012",
    "Q3": "11014",
    "ANNUAL": "11011",
}

# Account names DART returns (Korean). We map each to our schema columns.
# fnlttSinglAcnt response: list of {"account_nm": ..., "thstrm_amount": ..., ...}
ACCOUNT_MAP = {
    "매출액":      "revenue",
    "수익(매출액)": "revenue",
    "영업이익":    "operating_income",
    "당기순이익":  "net_income",
}


def _api_key() -> str:
    key = os.environ.get("DART_API_KEY")
    if not key:
        raise RuntimeError("DART_API_KEY env var not set")
    return key


def _pace(seconds: float = 0.5) -> None:
    time.sleep(seconds)


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type(Exception),
    reraise=True,
)
def fetch_corp_code_zip() -> bytes:
    """Download the bulk corpCode.xml zip (~10MB).

    Returns the raw zip bytes. Caller should call `parse_corp_codes` to get
    {ticker: (corp_code, corp_name)} for KOSPI/KOSDAQ-listed entries.
    """
    log.info("[dart] downloading corpCode.xml zip ...")
    with httpx.Client(timeout=60.0) as client:
        r = client.get(f"{DART_BASE}/corpCode.xml", params={"crtfc_key": _api_key()})
        r.raise_for_status()
        return r.content


def parse_corp_codes(zip_bytes: bytes) -> dict[str, tuple[str, str]]:
    """Parse corpCode.xml → {stock_code: (corp_code, corp_name)}.

    Skips entries without stock_code (delisted / private companies).
    """
    out: dict[str, tuple[str, str]] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        with zf.open("CORPCODE.xml") as f:
            tree = ET.parse(f)
    for entry in tree.getroot().findall("list"):
        stock_code = (entry.findtext("stock_code") or "").strip()
        if not stock_code or stock_code == " ":
            continue
        corp_code = (entry.findtext("corp_code") or "").strip()
        corp_name = (entry.findtext("corp_name") or "").strip()
        if corp_code and stock_code:
            out[stock_code] = (corp_code, corp_name)
    log.info("[dart] parsed %d listed companies", len(out))
    return out


@retry(
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=1, max=8),
    retry=retry_if_exception_type(Exception),
    reraise=True,
)
def fetch_single_company_accounts(
    corp_code: str, year: int, report_code: str,
) -> dict[str, Any]:
    """`/api/fnlttSinglAcnt.json` — single company main accounts.

    Returns the parsed JSON. status='000' = OK, '013' = 데이터 없음 (회사가
    해당 reprt_code로 공시 안 함, 흔함), '014' = invalid request, etc.
    """
    with httpx.Client(timeout=20.0) as client:
        r = client.get(
            f"{DART_BASE}/fnlttSinglAcnt.json",
            params={
                "crtfc_key":  _api_key(),
                "corp_code":  corp_code,
                "bsns_year":  str(year),
                "reprt_code": report_code,
            },
        )
        r.raise_for_status()
        return r.json()


def extract_financial_metrics(payload: dict[str, Any]) -> dict[str, int | None]:
    """Pull revenue / operating_income / net_income from a fnlttSinglAcnt
    response.

    Looks at consolidated statements first (CFS), falls back to separate (OFS).
    Amount strings come with commas — strip and cast to int. Skips negative
    sentinel '-' which DART returns for missing values.
    """
    if payload.get("status") != "000":
        return {}
    out: dict[str, int | None] = {"revenue": None, "operating_income": None, "net_income": None}

    # Prefer consolidated statements (CFS = 연결재무제표)
    for fs_div in ("CFS", "OFS"):
        for row in payload.get("list", []):
            if row.get("fs_div") != fs_div:
                continue
            account_nm = (row.get("account_nm") or "").strip()
            metric = ACCOUNT_MAP.get(account_nm)
            if not metric or out.get(metric) is not None:
                continue
            raw = (row.get("thstrm_amount") or "").replace(",", "").strip()
            if not raw or raw == "-":
                continue
            try:
                out[metric] = int(raw)
            except ValueError:
                continue
        # If consolidated gave us all 3, stop. Otherwise try separate.
        if all(v is not None for v in out.values()):
            return out
    return out


def extract_prev_year_metrics(payload: dict[str, Any]) -> dict[str, int | None]:
    """Same as `extract_financial_metrics` but reads `frmtrm_amount`
    (전기 동일분기 = previous year same period) for YoY computation."""
    if payload.get("status") != "000":
        return {}
    out: dict[str, int | None] = {"revenue": None, "operating_income": None, "net_income": None}
    for fs_div in ("CFS", "OFS"):
        for row in payload.get("list", []):
            if row.get("fs_div") != fs_div:
                continue
            account_nm = (row.get("account_nm") or "").strip()
            metric = ACCOUNT_MAP.get(account_nm)
            if not metric or out.get(metric) is not None:
                continue
            raw = (row.get("frmtrm_amount") or "").replace(",", "").strip()
            if not raw or raw == "-":
                continue
            try:
                out[metric] = int(raw)
            except ValueError:
                continue
        if all(v is not None for v in out.values()):
            return out
    return out


def yoy(current: int | None, previous: int | None) -> float | None:
    """YoY growth as a fraction. Skip when prev is missing or non-positive
    (sign flip on negatives makes the ratio meaningless)."""
    if current is None or previous is None or previous <= 0:
        return None
    return (current - previous) / previous
