"""Data-access helpers shared by characters.

Pure DB → typed-dataclass conversion; no business logic. Tested via
the cycle orchestrator's integration test (M2-T5) since the shape is
trivial. Each helper raises ``InsufficientDataError`` when the data
window is too thin for the caller's downstream math.

The legacy Python pipeline already has its own client factory
(``db.supabase_client.get_admin_client``) — we reuse it rather than
mint another so connection pooling stays singular.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from datetime import date as Date

from agents.characters._base import InsufficientDataError
from db.supabase_client import get_admin_client
from supabase import Client


@dataclass(frozen=True)
class KrFundamentalsRow:
    date: Date
    ticker: str
    forward_pe: float | None
    trailing_pe: float | None
    price_to_book: float | None
    roe: float | None
    market_cap: int | None


@dataclass(frozen=True)
class KrFinancialsRow:
    ticker: str
    fiscal_year: int
    reprt_code: str
    period_end: Date | None
    revenue: int | None
    operating_income: int | None
    net_income: int | None
    revenue_yoy: float | None
    op_income_yoy: float | None
    net_income_yoy: float | None


@dataclass(frozen=True)
class KrQuoteRow:
    date: Date
    ticker: str
    open: int | None
    high: int | None
    low: int | None
    close: int | None
    volume: int | None
    trading_value: int | None
    foreign_net_buy: int | None
    change_rate: float | None


def _client(client: Client | None = None) -> Client:
    return client or get_admin_client()


def _parse_date(s: str | None) -> Date | None:
    if s is None:
        return None
    return Date.fromisoformat(s)


def latest_fundamentals(
    ticker: str, client: Client | None = None
) -> KrFundamentalsRow | None:
    """Most recent kr_fundamentals row for the ticker, or ``None``."""
    sb = _client(client)
    res = (
        sb.table("kr_fundamentals")
        .select("*")
        .eq("ticker", ticker)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    if not rows:
        return None
    r = rows[0]
    return KrFundamentalsRow(
        date=Date.fromisoformat(r["date"]),
        ticker=r["ticker"],
        forward_pe=r.get("forward_pe"),
        trailing_pe=r.get("trailing_pe"),
        price_to_book=r.get("price_to_book"),
        roe=r.get("roe"),
        market_cap=r.get("market_cap"),
    )


def recent_financials(
    ticker: str, n: int = 8, client: Client | None = None
) -> list[KrFinancialsRow]:
    """Last ``n`` quarters newest-first. May return fewer rows; the
    caller decides whether the window is long enough."""
    sb = _client(client)
    res = (
        sb.table("kr_financials")
        .select("*")
        .eq("ticker", ticker)
        .order("period_end", desc=True)
        .limit(n)
        .execute()
    )
    out: list[KrFinancialsRow] = []
    for r in res.data or []:
        out.append(
            KrFinancialsRow(
                ticker=r["ticker"],
                fiscal_year=int(r["fiscal_year"]),
                reprt_code=r["reprt_code"],
                period_end=_parse_date(r.get("period_end")),
                revenue=r.get("revenue"),
                operating_income=r.get("operating_income"),
                net_income=r.get("net_income"),
                revenue_yoy=r.get("revenue_yoy"),
                op_income_yoy=r.get("op_income_yoy"),
                net_income_yoy=r.get("net_income_yoy"),
            )
        )
    return out


def daily_quotes(
    ticker: str,
    days: int = 252,
    as_of: Date | None = None,
    client: Client | None = None,
) -> list[KrQuoteRow]:
    """Last ``days`` calendar days of korea_market rows, newest first.
    The result may have fewer than ``days`` entries because non-
    trading days are absent — callers should slice by count, not date.
    """
    sb = _client(client)
    end = as_of or datetime.now(UTC).date()
    start = end - timedelta(days=days * 2)  # generous calendar window
    res = (
        sb.table("korea_market")
        .select("*")
        .eq("ticker", ticker)
        .gte("date", start.isoformat())
        .lte("date", end.isoformat())
        .order("date", desc=True)
        .limit(days)
        .execute()
    )
    out: list[KrQuoteRow] = []
    for r in res.data or []:
        out.append(
            KrQuoteRow(
                date=Date.fromisoformat(r["date"]),
                ticker=r["ticker"],
                open=r.get("open"),
                high=r.get("high"),
                low=r.get("low"),
                close=r.get("close"),
                volume=r.get("volume"),
                trading_value=r.get("trading_value"),
                foreign_net_buy=r.get("foreign_net_buy"),
                change_rate=r.get("change_rate"),
            )
        )
    return out


def require_min_quotes(
    quotes: list[KrQuoteRow], minimum: int, *, character: str, ticker: str
) -> None:
    """Convenience guard — raises ``InsufficientDataError`` when the
    data window is too thin."""
    if len(quotes) < minimum:
        raise InsufficientDataError(
            character=character,
            ticker=ticker,
            reason=f"{minimum} quotes required, got {len(quotes)}",
        )
