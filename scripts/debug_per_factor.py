"""For ticker 005930, walk each scorer factor and report why it returns NEUTRAL."""
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client


def main() -> None:
    sb = get_admin_client()
    ticker = "005930"
    on_date = Date(2026, 5, 7)
    print(f"=== Ticker {ticker} on {on_date} ===\n")

    # 1. korea_market rows (45-day window for volume_flow, 21-day for risk)
    since = (on_date - timedelta(days=45)).isoformat()
    rows = (
        sb.table("korea_market")
          .select("date, close, change_rate, volume, foreign_net_buy, institution_net_buy")
          .eq("ticker", ticker)
          .gte("date", since)
          .lte("date", on_date.isoformat())
          .order("date", desc=True)
          .limit(50)
          .execute()
          .data
    ) or []
    print(f"korea_market: {len(rows)} rows in 45-day window")
    for r in rows[:5]:
        print(f"  {r}")
    print(f"  ... [{len(rows)} total]\n")

    # 2. news_items for ticker (3-day window)
    since3 = (on_date - timedelta(days=3)).isoformat()
    rows = (
        sb.table("news_items")
          .select("date, title, sentiment_score, sentiment_label, related_symbols")
          .gte("date", since3)
          .lte("date", on_date.isoformat())
          .contains("related_symbols", [ticker])
          .limit(20)
          .execute()
          .data
    ) or []
    print(f"news_items mentioning {ticker} in 3-day window: {len(rows)} rows")
    for r in rows[:3]:
        print(f"  {r['date']}: sentiment={r.get('sentiment_score')} '{r.get('title','')[:60]}'")

    # 3. all news_items in last 3 days (without ticker filter)
    rows = (
        sb.table("news_items")
          .select("date, related_symbols, sentiment_score, sentiment_label", count="exact")
          .gte("date", since3)
          .lte("date", on_date.isoformat())
          .limit(5)
          .execute()
    )
    print(f"\nALL news_items in 3-day window: count={rows.count}")
    for r in (rows.data or []):
        print(f"  {r['date']}: symbols={r.get('related_symbols')} sentiment={r.get('sentiment_score')}")

    # 4. all KR tickers with korea_market on 5/6
    rows = (
        sb.table("korea_market")
          .select("ticker", count="exact")
          .eq("date", "2026-05-06")
          .limit(5)
          .execute()
    )
    print(f"\nkorea_market on 2026-05-06: count={rows.count}")
    for r in (rows.data or [])[:3]:
        print(f"  {r}")


if __name__ == "__main__":
    main()
