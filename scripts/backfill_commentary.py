"""Generate AI Quant Expert commentary for all watchlist tickers on a date.

Reads ai_scores + korea_market + kr_financials + recent news and feeds
each into cognition.commentary.CommentaryEngine. Idempotent — re-runs
only generate for missing (date, ticker) rows in ai_commentary.

Usage:
  python -m scripts.backfill_commentary --date 2026-05-07
  python -m scripts.backfill_commentary --date 2026-05-07 --model claude-sonnet-4-6
  python -m scripts.backfill_commentary --date 2026-05-07 --force
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client


async def main(target: Date, model: str, force: bool, limit: int) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[commentary] ANTHROPIC_API_KEY not set -- aborting")
        sys.exit(1)

    from cognition.commentary import CommentaryEngine

    sb = get_admin_client()

    # Already-generated tickers for this date (skip unless --force)
    existing: set[str] = set()
    if not force:
        rows = (
            sb.table("ai_commentary").select("ticker").eq("date", target.isoformat())
              .execute().data
        ) or []
        existing = {r["ticker"] for r in rows}
        if existing:
            print(f"[commentary] {len(existing)} already generated for {target} (skip)")

    # ai_scores rows (ticker + sub_scores) joined with stocks
    score_rows = (
        sb.table("ai_scores")
          .select("*, stocks(name, sector)")
          .eq("date", target.isoformat())
          .execute().data
    ) or []
    if not score_rows:
        print(f"[commentary] no ai_scores for {target}")
        return
    todo = [r for r in score_rows if r["ticker"] not in existing]
    if limit > 0:
        todo = todo[:limit]
    print(f"[commentary] {len(todo)} tickers to process · model={model}")
    if not todo:
        return

    engine = CommentaryEngine(model=model)

    # Pre-fetch quote / fundamental / news to minimize per-iteration round trips
    tickers = [r["ticker"] for r in todo]
    quote_rows = (
        sb.table("korea_market").select("ticker, close, change_rate, volume")
          .eq("date", target.isoformat()).in_("ticker", tickers)
          .execute().data
    ) or []
    quote_by_ticker = {r["ticker"]: r for r in quote_rows}

    fund_rows = (
        sb.table("kr_financials")
          .select("ticker, revenue_yoy, op_income_yoy, fiscal_year, reprt_code")
          .in_("ticker", tickers)
          .order("period_end", desc=True)
          .execute().data
    ) or []
    fund_by_ticker: dict[str, dict] = {}
    for r in fund_rows:
        fund_by_ticker.setdefault(r["ticker"], r)
    fpe_rows = (
        sb.table("kr_fundamentals").select("ticker, forward_pe, roe")
          .in_("ticker", tickers).order("date", desc=True)
          .execute().data
    ) or []
    fpe_by_ticker: dict[str, dict] = {}
    for r in fpe_rows:
        fpe_by_ticker.setdefault(r["ticker"], r)

    # News: latest 5 titles per ticker (3-day window) — simple direct lookup,
    # us_kr_mapping fallback handled by frontend if KR ticker has no direct
    since3 = (target - timedelta(days=3)).isoformat()
    news_rows = (
        sb.table("news_items").select("title, related_symbols")
          .gte("date", since3).lte("date", target.isoformat())
          .not_.is_("title", "null")
          .execute().data
    ) or []
    news_by_ticker: dict[str, list[str]] = {}
    for r in news_rows:
        for sym in (r.get("related_symbols") or []):
            news_by_ticker.setdefault(sym, []).append(r["title"])
            if len(news_by_ticker[sym]) >= 5:
                break

    completed = 0
    failed = 0

    async def process(score_row: dict) -> None:
        nonlocal completed, failed
        ticker = score_row["ticker"]
        meta = score_row.get("stocks") or {}
        sub_scores = {
            "global_market":     score_row.get("global_market_score"),
            "sector":            score_row.get("sector_score"),
            "related_us_stock":  score_row.get("related_us_stock_score"),
            "news_sentiment":    score_row.get("news_sentiment_score"),
            "fundamental":       score_row.get("fundamental_score"),
            "volume_flow":       score_row.get("volume_flow_score"),
            "risk_penalty":      score_row.get("risk_penalty"),
        }
        fund_data: dict = {}
        if ticker in fund_by_ticker:
            fund_data.update(fund_by_ticker[ticker])
        if ticker in fpe_by_ticker:
            fund_data["forward_pe"] = fpe_by_ticker[ticker].get("forward_pe")
            fund_data["roe"] = fpe_by_ticker[ticker].get("roe")
        payload = {
            "ticker":      ticker,
            "name":        meta.get("name"),
            "sector":      meta.get("sector"),
            "score":       {
                "signal":      score_row.get("signal"),
                "final_score": score_row.get("final_score"),
                "sub_scores":  sub_scores,
            },
            "quote":       quote_by_ticker.get(ticker),
            "fundamental": fund_data,
            "recent_news": news_by_ticker.get(ticker, []),
        }

        try:
            commentary = await engine.generate(payload)
        except Exception as exc:
            failed += 1
            if failed <= 5:
                print(f"  [{ticker}] failed: {exc}")
            return

        cost = 0.005 if "haiku" in model else 0.015
        sb.table("ai_commentary").upsert({
            "date":          target.isoformat(),
            "ticker":        ticker,
            "headline":      commentary.headline,
            "body":          commentary.body,
            "short_term":    commentary.short_term,
            "mid_term":      commentary.mid_term,
            "catalysts":     commentary.catalysts,
            "risks":         commentary.risks,
            "model":         model,
            "cost_estimate": cost,
        }, on_conflict="date,ticker").execute()
        completed += 1
        if completed % 10 == 0:
            print(f"  ... {completed}/{len(todo)} done")

    # Concurrency cap (engine has its own internal sem; we add outer cap)
    sem = asyncio.Semaphore(int(os.environ.get("COMMENTARY_CONCURRENCY", "4")))

    async def gated(row: dict) -> None:
        async with sem:
            await process(row)

    await asyncio.gather(*(gated(r) for r in todo))
    print(f"\n[commentary] done: completed={completed} failed={failed}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date",  type=str, required=True)
    ap.add_argument("--model", type=str, default="claude-haiku-4-5")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--force", action="store_true",
                    help="regenerate even if (date, ticker) row exists")
    args = ap.parse_args()
    asyncio.run(main(Date.fromisoformat(args.date), args.model, args.force, args.limit))
