"""
Voter-flatness diagnostic.

Finds which sub-score columns went constant (low variance) recently,
which is the prime suspect when final_score collapses to a flat line.

Reads ai_scores for the past N days (default 14) for a target ticker
(default 005930) and prints:
  - per-voter std-dev over the window
  - per-voter min/max/mean
  - "flat" voters (std < 0.05) flagged

Run:
  python -m scripts.diagnose_voter_flatness                       # 005930, 14d
  python -m scripts.diagnose_voter_flatness --ticker 000660       # SK Hynix
  python -m scripts.diagnose_voter_flatness --days 30 --ticker 005930
"""
from __future__ import annotations

import argparse
import statistics
from datetime import date, timedelta

from db.supabase_client import get_admin_client

VOTER_COLS = (
    "global_market_score",
    "sector_score",
    "related_us_stock_score",
    "news_sentiment_score",
    "fundamental_score",
    "volume_flow_score",
    "risk_penalty",
    "kr_fear_greed_score",
    "final_score",
)

FLAT_STD_THRESHOLD = 0.05


def main() -> int:
    p = argparse.ArgumentParser(description="Voter-flatness diagnostic")
    p.add_argument("--ticker", default="005930", help="ticker to inspect (default 005930)")
    p.add_argument("--days", type=int, default=14, help="lookback window (default 14)")
    args = p.parse_args()

    end = date.today()
    start = end - timedelta(days=args.days)
    sb = get_admin_client()

    cols = ",".join(("date",) + VOTER_COLS)
    res = (
        sb.table("ai_scores")
        .select(cols)
        .eq("ticker", args.ticker)
        .gte("date", start.isoformat())
        .lte("date", end.isoformat())
        .order("date", desc=False)
        .execute()
    )
    rows = res.data or []
    if not rows:
        print(f"No ai_scores rows for {args.ticker} in [{start}, {end}].")
        return 1

    print(f"# Voter flatness — {args.ticker}  ({len(rows)} days, {rows[0]['date']} → {rows[-1]['date']})\n")

    # Stat per column.
    print("| voter | mean | std | min | max | range | flat? |")
    print("|---|---|---|---|---|---|---|")
    for col in VOTER_COLS:
        vals = [float(r[col]) for r in rows if r.get(col) is not None]
        if len(vals) < 2:
            print(f"| {col} | n/a | n/a | n/a | n/a | n/a | (insufficient: {len(vals)}) |")
            continue
        m = statistics.mean(vals)
        s = statistics.stdev(vals) if len(vals) > 1 else 0.0
        lo = min(vals)
        hi = max(vals)
        rng = hi - lo
        flat = "🔴 FLAT" if s < FLAT_STD_THRESHOLD else "✅"
        print(f"| {col} | {m:.3f} | {s:.3f} | {lo:.3f} | {hi:.3f} | {rng:.3f} | {flat} |")

    print("\n## Per-day breakdown\n")
    print("| date | " + " | ".join(c.replace("_score", "").replace("_", " ") for c in VOTER_COLS) + " |")
    print("|---" + "|---" * len(VOTER_COLS) + "|")
    for r in rows:
        cells = []
        for col in VOTER_COLS:
            v = r.get(col)
            cells.append(f"{float(v):.3f}" if v is not None else " — ")
        print(f"| {r['date']} | " + " | ".join(cells) + " |")

    print("\n## Interpretation\n")
    print("- A voter with std < 0.05 over the window is effectively constant — "
          "its data source is missing or its formula is returning the same value daily.")
    print("- final_score 평탄화 = 모든 voter가 평탄해진 결과. 위 표에서 평탄한 voter들의 "
          "데이터 수집 파이프라인 (collectors/refinery/cognition 해당 모듈) 확인 필요.")
    print("- 정상 voter는 일별로 0.1~0.3 수준의 변동을 보여야 합니다.\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
