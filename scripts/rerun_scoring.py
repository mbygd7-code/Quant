"""Re-run cognition.scorer for a target date and overwrite ai_scores.

Use when scorer logic was patched (e.g. window-based input lookup) but the
ai_scores rows for the date were generated with the old strict-equality
logic and contain all-NEUTRAL fallbacks.

Usage:
  python -m scripts.rerun_scoring --date 2026-05-07
"""
from __future__ import annotations

import argparse
from datetime import date as Date

from cognition.scorer import StockScorer
from db.supabase_client import get_admin_client


def main(target: Date) -> None:
    sb = get_admin_client()

    # 1. Watchlist tickers
    rows = (
        sb.table("stocks").select("ticker, sector, name")
          .eq("is_watchlist", True).execute().data
    ) or []
    print(f"[rerun] {len(rows)} watchlist tickers")

    scorer = StockScorer()                                    # auto-loads active weights

    upserts: list[dict] = []
    for row in rows:
        ticker = row["ticker"]
        try:
            score = scorer.score(ticker, target)
        except Exception as exc:
            print(f"  {ticker}: scoring failed: {exc}")
            continue
        upserts.append({
            "date":                   target.isoformat(),
            "ticker":                 ticker,
            "global_market_score":    score.sub_scores.global_market,
            "sector_score":           score.sub_scores.sector,
            "related_us_stock_score": score.sub_scores.related_us_stock,
            "news_sentiment_score":   score.sub_scores.news_sentiment,
            "fundamental_score":      score.sub_scores.fundamental,
            "volume_flow_score":      score.sub_scores.volume_flow,
            "risk_penalty":           score.sub_scores.risk_penalty,
            "final_score":            score.final_score,
            "signal":                 score.signal,
            "rationale_json":         score.rationale.model_dump(mode="json"),
        })

    if not upserts:
        print("[rerun] no rows to upsert")
        return

    print(f"[rerun] upserting {len(upserts)} rows")
    sb.table("ai_scores").upsert(upserts, on_conflict="date,ticker").execute()
    print("[rerun] done")

    # Verification
    sigs: dict[str, int] = {}
    finals: list[float] = []
    for u in upserts:
        sigs[u["signal"]] = sigs.get(u["signal"], 0) + 1
        finals.append(u["final_score"])
    print(f"\n[verify] signal distribution: {sigs}")
    print(f"[verify] final_score: min={min(finals):.4f} "
          f"max={max(finals):.4f} distinct={len(set(round(f, 4) for f in finals))}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", type=str, required=True, help="YYYY-MM-DD")
    args = ap.parse_args()
    main(Date.fromisoformat(args.date))
