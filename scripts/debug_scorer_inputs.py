"""Why does scorer output 0.5 for every factor on every ticker?

Check the upstream tables that feed scoring."""
from db.supabase_client import get_admin_client


def main() -> None:
    sb = get_admin_client()

    target = "2026-05-07"

    print(f"=== Inputs available for {target} ===\n")

    tables = [
        ("korea_market", target),
        ("global_market", target),
        ("news_items", target),
        ("filings", target),
    ]
    for table, date in tables:
        n = (
            sb.table(table).select("*", count="exact", head=True)
              .eq("date", date).execute().count
        )
        print(f"{table:20} on {date}: {n} rows")

    # us_kr_mapping
    n = sb.table("us_kr_mapping").select("*", count="exact", head=True).execute().count
    print(f"{'us_kr_mapping':20} (all dates):   {n} rows")

    # Check actual KR price data for sample ticker
    sample = (
        sb.table("korea_market").select("*")
          .eq("ticker", "005930").eq("date", target).execute().data
    )
    print(f"\nsample 005930 on {target}: {sample}")

    # Check yesterday too
    yest = "2026-05-06"
    n_yest = (
        sb.table("korea_market").select("*", count="exact", head=True)
          .eq("date", yest).execute().count
    )
    print(f"korea_market on {yest}: {n_yest} rows")

    # Check ai_scores rationale_json — does it contain any meaningful data?
    rat = (
        sb.table("ai_scores").select("ticker, rationale_json")
          .eq("date", target).limit(2).execute().data
    )
    for r in rat:
        print(f"\nrationale {r['ticker']}: {r.get('rationale_json')}")


if __name__ == "__main__":
    main()
