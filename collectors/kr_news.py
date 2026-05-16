"""KR news collector — per-ticker news from NAVER Finance.

Solves the cognition/scorer.py `news_sentiment_score = 0.50` (NEUTRAL
default) problem: previously the only news ingested was Finnhub's
US-symbol feed, so KR tickers fell through to a hardcoded neutral.

NAVER Finance exposes a per-ticker news API at
``https://api.stock.naver.com/news/related?code={ticker}&pageSize=N``
which returns the same articles shown on the stock detail page. No
auth, no rate limit advertised — we self-pace at 1 req/sec to be
polite.

The collector writes into the existing ``news_items`` table (migration
2) using its ``related_symbols`` array column to tag the ticker. No
schema change required. Sentiment scoring runs as a separate step
through ``cognition/sentiment.py`` (Claude does the labelling).

Coverage strategy:
  - Hot path: per-cron pull, last 24h of news for each watchlist ticker
  - Backfill: ``scripts/backfill_kr_news.py`` covers the previous
    30 days on first run

Rationale for NAVER specifically over RSS-aggregator approaches:
  • Already ticker-tagged at source — no NER required to associate an
    article with 005930
  • Korean-native content (한경/매경/연합 syndication)
  • Stable JSON shape (vs RSS XML quirks across publishers)
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime
from datetime import date as Date
from typing import Any

import httpx

log = logging.getLogger("collectors.kr_news")

NAVER_ENDPOINT = "https://api.stock.naver.com/news/related"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
#: Self-imposed pacing — 1 request/second to avoid abusing NAVER.
PACE_SECONDS = 1.0
#: How many headlines to pull per ticker per call.
PAGE_SIZE = 20


async def fetch_ticker_news(
    client: httpx.AsyncClient,
    ticker: str,
    *,
    page_size: int = PAGE_SIZE,
) -> list[dict[str, Any]]:
    """Pull the most recent N news articles for one KR ticker.

    Returns a list of raw NAVER JSON items. Empty list on any error
    (logged) so a single ticker failure doesn't tank the whole run.
    """
    try:
        resp = await client.get(
            NAVER_ENDPOINT,
            params={"code": ticker, "pageSize": page_size},
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Referer": f"https://m.stock.naver.com/domestic/stock/{ticker}/news",
            },
            timeout=10.0,
        )
        resp.raise_for_status()
        body = resp.json()
        # The endpoint returns either {"items": [...]} or a bare list
        # depending on the path version. Normalise both.
        if isinstance(body, dict):
            return body.get("items", []) or []
        return body or []
    except Exception as exc:  # noqa: BLE001
        log.warning("[kr_news] %s fetch failed: %s", ticker, exc)
        return []


def parse_naver_news_item(
    raw: dict[str, Any],
    ticker: str,
) -> dict[str, Any] | None:
    """Translate a NAVER raw item to the news_items row shape.

    Returns None if the item is missing required fields — the cycle
    treats that as a silent skip, not an error.
    """
    title = (raw.get("title") or "").strip()
    link = raw.get("linkUrl") or raw.get("officeUrl") or ""
    if not title or not link:
        return None

    # NAVER's `datetime` is "YYYYMMDDHHMMSS"; published_at is the more
    # liberal "datetime"-named field. Try both.
    raw_dt = raw.get("datetime") or raw.get("publishedAt") or ""
    published_at: datetime | None = None
    if isinstance(raw_dt, str) and len(raw_dt) >= 14 and raw_dt.isdigit():
        try:
            published_at = datetime.strptime(raw_dt[:14], "%Y%m%d%H%M%S").replace(
                tzinfo=UTC,
            )
        except ValueError:
            published_at = None

    date_iso = (published_at or datetime.now(UTC)).date().isoformat()
    source = (raw.get("officeName") or raw.get("source") or "NAVER").strip()[:50]

    return {
        "date": date_iso,
        "published_at": published_at.isoformat() if published_at else None,
        "source": source,
        "title": title[:500],  # defensive trim; news_items.title is TEXT
        "body": (raw.get("subTitle") or raw.get("summary") or "").strip()[:2000],
        "url": link[:500],
        "related_symbols": [ticker],
        # sentiment_score/label left NULL — populated by cognition/sentiment.py
        # in a separate pass. importance defaults NULL too.
    }


async def collect_for_tickers(
    tickers: list[str],
    *,
    page_size: int = PAGE_SIZE,
    pace_seconds: float = PACE_SECONDS,
) -> list[dict[str, Any]]:
    """Pull recent news for a batch of tickers, self-paced.

    The cycle worker calls this once per cron with the watchlist
    union. Returns deduped rows ready to upsert (`on_conflict=url`).
    """
    rows: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    async with httpx.AsyncClient() as client:
        for i, ticker in enumerate(tickers):
            if i > 0:
                # Pace AFTER the first request so the first hit isn't delayed.
                await asyncio.sleep(pace_seconds)
            items = await fetch_ticker_news(client, ticker, page_size=page_size)
            for raw in items:
                parsed = parse_naver_news_item(raw, ticker)
                if parsed is None:
                    continue
                if parsed["url"] in seen_urls:
                    # Same article tagged for multiple tickers — union the
                    # related_symbols instead of duplicating the row.
                    for r in rows:
                        if r["url"] == parsed["url"]:
                            existing = set(r["related_symbols"])
                            existing.add(ticker)
                            r["related_symbols"] = sorted(existing)
                            break
                    continue
                seen_urls.add(parsed["url"])
                rows.append(parsed)
    return rows


def upsert_news_rows(supabase, rows: list[dict[str, Any]]) -> int:  # noqa: ANN001
    """Insert/update news_items rows. ``url`` is the conflict key.

    Returns the number of rows attempted (Supabase upserts don't
    differentiate inserts vs updates in their response shape).
    """
    if not rows:
        return 0
    # The supabase-py upsert silently overwrites — including any sentiment
    # scoring done on a previous pass. Skip URLs that already exist so
    # sentiment work isn't wasted.
    urls = [r["url"] for r in rows]
    existing = (
        supabase.table("news_items")
        .select("url")
        .in_("url", urls)
        .execute()
        .data
        or []
    )
    existing_urls = {r["url"] for r in existing}
    fresh = [r for r in rows if r["url"] not in existing_urls]
    if not fresh:
        return 0
    supabase.table("news_items").insert(fresh).execute()
    return len(fresh)


def collect_and_persist(
    supabase,  # noqa: ANN001
    tickers: list[str],
    *,
    page_size: int = PAGE_SIZE,
    pace_seconds: float = PACE_SECONDS,
) -> dict[str, int]:
    """Sync entrypoint for the daily-pipeline cron.

    Bundles the async fetch + DB write into a single call. Returns a
    summary dict for the cron's CycleReport.
    """
    rows = asyncio.run(
        collect_for_tickers(tickers, page_size=page_size, pace_seconds=pace_seconds)
    )
    inserted = upsert_news_rows(supabase, rows)
    return {
        "tickers": len(tickers),
        "fetched": len(rows),
        "inserted": inserted,
        "duplicate_skipped": len(rows) - inserted,
    }


# ─── CLI ───────────────────────────────────────────────────────────


if __name__ == "__main__":
    import argparse

    from db.supabase_client import get_admin_client

    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--tickers", required=True, help="comma-separated KR tickers")
    p.add_argument("--page-size", type=int, default=PAGE_SIZE)
    p.add_argument("--pace", type=float, default=PACE_SECONDS)
    args = p.parse_args()

    tickers = [t.strip() for t in args.tickers.split(",") if t.strip()]
    sb = get_admin_client()
    start = time.time()
    summary = collect_and_persist(
        sb, tickers, page_size=args.page_size, pace_seconds=args.pace
    )
    elapsed = time.time() - start
    print(
        f"[kr_news] {summary['tickers']} tickers · {summary['fetched']} fetched "
        f"· {summary['inserted']} inserted · {summary['duplicate_skipped']} dup "
        f"· {elapsed:.1f}s"
    )
