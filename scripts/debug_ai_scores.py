"""Why does every ai_score row show 0.45/주의?

Check sub-score variance + raw inputs to scorer."""
from db.supabase_client import get_admin_client


def main() -> None:
    sb = get_admin_client()

    # Latest 50 ai_scores rows
    rows = (
        sb.table("ai_scores")
          .select("date, ticker, global_market_score, sector_score, "
                  "related_us_stock_score, news_sentiment_score, "
                  "fundamental_score, volume_flow_score, risk_penalty, "
                  "final_score, signal")
          .order("date", desc=True)
          .limit(50)
          .execute()
          .data
    ) or []

    if not rows:
        print("ai_scores table is empty")
        return

    print(f"latest date: {rows[0]['date']}")
    print(f"sample size: {len(rows)}\n")

    # Check final_score variance
    finals = [r["final_score"] for r in rows]
    print(f"final_score: min={min(finals):.4f} max={max(finals):.4f} "
          f"distinct={len(set(finals))}")

    # Per-factor variance
    factors = ["global_market_score", "sector_score", "related_us_stock_score",
               "news_sentiment_score", "fundamental_score",
               "volume_flow_score", "risk_penalty"]
    print("\nper-factor distinct value counts:")
    for f in factors:
        vals = [r[f] for r in rows if r[f] is not None]
        if vals:
            print(f"  {f:30} distinct={len(set(round(v, 4) for v in vals)):3} "
                  f"min={min(vals):.4f} max={max(vals):.4f} sample={vals[0]:.4f}")
        else:
            print(f"  {f:30} ALL NULL")

    # Signal distribution
    sigs: dict[str, int] = {}
    for r in rows:
        sigs[r["signal"]] = sigs.get(r["signal"], 0) + 1
    print(f"\nsignal distribution: {sigs}")

    # 3 sample rows full
    print("\nfirst 3 rows:")
    for r in rows[:3]:
        print(f"  {r['ticker']}: {r}")


if __name__ == "__main__":
    main()
