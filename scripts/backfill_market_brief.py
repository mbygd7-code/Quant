"""Generate one MarketBrief for the given date and persist to market_briefs.

Idempotent: re-runs are skipped unless --force.

Usage:
  python -m scripts.backfill_market_brief --date 2026-05-07
  python -m scripts.backfill_market_brief --date 2026-05-07 --force
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client


async def main(target: Date, model: str, force: bool) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("[brief] ANTHROPIC_API_KEY not set -- aborting")
        sys.exit(1)

    from cognition.market_brief import MarketBriefEngine

    sb = get_admin_client()

    if not force:
        existing = (
            sb.table("market_briefs").select("date")
              .eq("date", target.isoformat()).limit(1).execute().data
        )
        if existing:
            print(f"[brief] already generated for {target} (use --force to overwrite)")
            return

    # Build payload
    # 1) Global indices for the date (window-aware: latest at-or-before)
    since = (target - timedelta(days=10)).isoformat()
    global_rows = (
        sb.table("global_market").select("date, symbol, close, change_rate")
          .gte("date", since).lte("date", target.isoformat())
          .in_("symbol", ["^IXIC", "^GSPC", "^SOX", "^VIX"])
          .order("date", desc=True).execute().data
    ) or []
    latest_global: dict = {}
    for r in global_rows:
        latest_global.setdefault(r["symbol"], r)
    global_arr = [{"symbol": s, **latest_global[s]} for s in latest_global]

    # 2) Macro factors
    macro_rows = (
        sb.table("global_market").select("date, symbol, change_rate")
          .gte("date", since).lte("date", target.isoformat())
          .in_("symbol", ["USDKRW", "^TNX", "DXY", "WTI"])
          .order("date", desc=True).execute().data
    ) or []
    latest_macro: dict[str, float] = {}
    for r in macro_rows:
        if r["symbol"] not in latest_macro and r.get("change_rate") is not None:
            latest_macro[r["symbol"]] = float(r["change_rate"])

    # 3) ai_scores top + risk
    score_rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, stocks(name, sector)")
          .eq("date", target.isoformat())
          .order("final_score", desc=True)
          .execute().data
    ) or []
    if not score_rows:
        print(f"[brief] no ai_scores for {target} -- aborting")
        return

    top_signals = [
        {
            "ticker": r["ticker"],
            "signal": r["signal"],
            "final_score": r["final_score"],
            "name": (r.get("stocks") or {}).get("name"),
            "sector": (r.get("stocks") or {}).get("sector"),
        }
        for r in score_rows[:8]
    ]
    # Risk watch — bottom-quartile + signal containing 위험/주의
    risk_signals = [
        {
            "ticker": r["ticker"],
            "signal": r["signal"],
            "final_score": r["final_score"],
            "name": (r.get("stocks") or {}).get("name"),
            "sector": (r.get("stocks") or {}).get("sector"),
        }
        for r in score_rows
        if r["signal"] in ("위험", "주의") or r["final_score"] < 0.5
    ][:6]

    # 4) Sector temperatures (avg final_score per sector)
    sector_buckets: dict[str, list[float]] = {}
    for r in score_rows:
        sector = (r.get("stocks") or {}).get("sector")
        if sector:
            sector_buckets.setdefault(sector, []).append(float(r["final_score"]))
    sectors = [
        {"name": s, "avg_score": sum(v) / len(v)}
        for s, v in sector_buckets.items()
    ]
    sectors.sort(key=lambda x: -x["avg_score"])

    payload = {
        "date":          target.isoformat(),
        "global":        global_arr,
        "sectors":       sectors,
        "macro":         latest_macro,
        "top_signals":   top_signals,
        "risk_signals":  risk_signals,
    }

    engine = MarketBriefEngine(model=model)
    print(f"[brief] generating · model={model}")
    brief = await engine.generate(payload)
    print(f"  headline: {brief.headline}")

    cost = 0.005 if "haiku" in model else 0.02
    sb.table("market_briefs").upsert({
        "date":          target.isoformat(),
        "headline":      brief.headline,
        "body":          brief.body,
        "sector_view":   brief.sector_view,
        "top_picks":     brief.top_picks,
        "risk_watch":    brief.risk_watch,
        "macro_summary": brief.macro_summary,
        "model":         model,
        "cost_estimate": cost,
    }, on_conflict="date").execute()
    print("[brief] saved")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date",  type=str, required=True)
    ap.add_argument("--model", type=str, default="claude-haiku-4-5")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    asyncio.run(main(Date.fromisoformat(args.date), args.model, args.force))
