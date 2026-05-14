"""Tests for the KR news parser. IO-free — fixtures only."""
from __future__ import annotations

from collectors.kr_news import parse_naver_news_item


def test_parses_standard_naver_payload() -> None:
    raw = {
        "title": "삼성전자, 메모리 가격 인상으로 영업이익 33% 증가",
        "linkUrl": "https://news.naver.com/article/123",
        "datetime": "20260515103045",
        "officeName": "한국경제",
        "subTitle": "본문 요약",
    }
    parsed = parse_naver_news_item(raw, "005930")
    assert parsed is not None
    assert parsed["title"].startswith("삼성전자")
    assert parsed["url"] == "https://news.naver.com/article/123"
    assert parsed["source"] == "한국경제"
    assert parsed["related_symbols"] == ["005930"]
    assert parsed["date"] == "2026-05-15"
    assert "2026-05-15" in (parsed["published_at"] or "")


def test_returns_none_without_title() -> None:
    raw = {"linkUrl": "https://x.com/y", "datetime": "20260515103045"}
    assert parse_naver_news_item(raw, "005930") is None


def test_returns_none_without_url() -> None:
    raw = {"title": "T", "datetime": "20260515103045"}
    assert parse_naver_news_item(raw, "005930") is None


def test_handles_malformed_datetime() -> None:
    raw = {
        "title": "Some headline",
        "linkUrl": "https://x.com/y",
        "datetime": "not-a-date",
    }
    parsed = parse_naver_news_item(raw, "005930")
    assert parsed is not None
    # Should still produce a valid row using `today` as the date fallback.
    assert parsed["date"]
    assert parsed["published_at"] is None


def test_trims_long_title_and_url() -> None:
    long_title = "타이틀" * 200  # 600 chars
    raw = {
        "title": long_title,
        "linkUrl": "https://x.com/" + "a" * 600,
        "datetime": "20260515000000",
        "officeName": "연합뉴스",
    }
    parsed = parse_naver_news_item(raw, "005930")
    assert parsed is not None
    assert len(parsed["title"]) <= 500
    assert len(parsed["url"]) <= 500


def test_falls_back_to_office_url() -> None:
    raw = {
        "title": "x",
        "officeUrl": "https://oo.kr/article/1",
        "datetime": "20260515000000",
    }
    parsed = parse_naver_news_item(raw, "005930")
    assert parsed is not None
    assert parsed["url"] == "https://oo.kr/article/1"


def test_uses_summary_as_body_fallback() -> None:
    raw = {
        "title": "x",
        "linkUrl": "https://x.com/y",
        "datetime": "20260515000000",
        "summary": "본문 요약 텍스트",
    }
    parsed = parse_naver_news_item(raw, "005930")
    assert parsed is not None
    assert "본문 요약" in (parsed["body"] or "")


def test_clamps_source_at_50_chars() -> None:
    raw = {
        "title": "x",
        "linkUrl": "https://x.com/y",
        "datetime": "20260515000000",
        "officeName": "매우매우매우매우매우매우매우매우매우매우매우매우매우긴출판사이름",
    }
    parsed = parse_naver_news_item(raw, "005930")
    assert parsed is not None
    assert len(parsed["source"]) <= 50
