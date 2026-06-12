"""DART disclosure collector — categorizer + parser + Taleb calendar."""
from __future__ import annotations

from datetime import datetime

from collectors.dart_events import categorize, fetch_corp_disclosures


class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _Client:
    def __init__(self, payload):
        self._payload = payload

    def get(self, *a, **k):
        return _Resp(self._payload)


# ─── categorize ────────────────────────────────────────────────────


def test_categorize_priority_and_buckets():
    assert categorize("연결재무제표기준영업(잠정)실적(공정공시)") == "잠정실적"
    assert categorize("분기보고서 (2026.03)") == "정기보고서"
    assert categorize("주요사항보고서(자기주식취득결정)") == "자사주"
    assert categorize("유상증자결정") == "증자/감자"
    assert categorize("단일판매ㆍ공급계약체결") == "공급계약"
    assert categorize("소송등의제기") == "소송"
    assert categorize("최대주주변경") == "지배구조"
    assert categorize("임상시험계획승인") == "임상/허가"
    assert categorize("기타경영사항(자율공시)") == "기타"


# ─── parser ────────────────────────────────────────────────────────


def test_fetch_parses_and_shapes_rows():
    payload = {
        "status": "000",
        "list": [
            {
                "rcept_no": "20260612000123",
                "corp_name": "삼성전자",
                "report_nm": "연결재무제표기준영업(잠정)실적(공정공시)",
                "rcept_dt": "20260612",
            },
            {  # malformed date → skipped
                "rcept_no": "2026061",
                "corp_name": "x",
                "report_nm": "y",
                "rcept_dt": "2026",
            },
        ],
    }
    rows = fetch_corp_disclosures(
        _Client(payload), "key", "00126380", "005930", "20260605", "20260612"
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["rcept_no"] == "20260612000123"
    assert r["ticker"] == "005930"
    assert r["category"] == "잠정실적"
    assert r["rcept_dt"] == "2026-06-12"
    assert r["url"].endswith("20260612000123")


def test_fetch_no_data_status_is_empty_not_error():
    rows = fetch_corp_disclosures(
        _Client({"status": "013", "message": "no data"}),
        "key", "00126380", "005930", "20260605", "20260612",
    )
    assert rows == []


# ─── Taleb statutory deadline calendar ─────────────────────────────


def test_statutory_deadline_calendar():
    from agents.characters.taleb import days_to_estimated_earnings

    # 6/12 → next deadline 8/14 (반기보고서) = 63 days
    assert days_to_estimated_earnings(datetime(2026, 6, 12), []) == 63
    # 5/10 → 5/15 분기보고서 = 5 days (earnings window!)
    assert days_to_estimated_earnings(datetime(2026, 5, 10), []) == 5
    # 12/20 → wraps to next year's 3/31 사업보고서 = 101 days
    assert days_to_estimated_earnings(datetime(2026, 12, 20), []) == 101
    # deadline day itself → 0
    assert days_to_estimated_earnings(datetime(2026, 11, 14), []) == 0
