"""Tests for the LNB favorites → Stage-2 universe selector."""
from __future__ import annotations

from unittest.mock import MagicMock

from agents.cycle._favorites import favorites_union


def _make_repo(rows: list[dict] | None, *, raise_on_query: bool = False):
    """Construct a minimal repo stub matching the supabase-py chain
    used inside `favorites_union` — `repo.client.table().select().execute().data`.

    Pass ``rows=None`` to assert the empty-table branch; pass a list to
    inject specific ticker rows; pass ``raise_on_query=True`` to verify
    the silent fallback when the table doesn't exist yet.
    """
    repo = MagicMock()
    if raise_on_query:
        repo.client.table.side_effect = RuntimeError("relation does not exist")
        return repo

    result = MagicMock()
    result.data = rows or []
    repo.client.table.return_value.select.return_value.execute.return_value = result
    return repo


def test_returns_empty_list_when_table_missing() -> None:
    """Migration 24 hasn't been applied yet → silent fallback to []."""
    repo = _make_repo(rows=None, raise_on_query=True)
    assert favorites_union(repo) == []


def test_returns_empty_list_when_no_rows() -> None:
    """Migration applied but no user has favorited anything → []."""
    repo = _make_repo(rows=[])
    assert favorites_union(repo) == []


def test_collects_distinct_tickers() -> None:
    """The union across users — deduped, insertion-order preserved."""
    repo = _make_repo(rows=[
        {"ticker": "005930"},
        {"ticker": "035720"},
        {"ticker": "005930"},  # same ticker, different user
        {"ticker": "000660"},
    ])
    assert favorites_union(repo) == ["005930", "035720", "000660"]


def test_uppercases_and_skips_empty() -> None:
    """ETF tickers may arrive lowercase; bad rows skipped."""
    repo = _make_repo(rows=[
        {"ticker": "0167a0"},   # SOL AI반도체TOP2플러스 — uppercase normalised
        {"ticker": ""},
        {"ticker": None},
        {"ticker": "005930"},
    ])
    assert favorites_union(repo) == ["0167A0", "005930"]


def test_handles_missing_ticker_key() -> None:
    """Defensive — a malformed row shouldn't crash the cycle worker."""
    repo = _make_repo(rows=[
        {"ticker": "005930"},
        {"other_col": "noise"},
        {"ticker": "035720"},
    ])
    assert favorites_union(repo) == ["005930", "035720"]
