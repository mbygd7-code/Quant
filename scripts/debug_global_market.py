"""Diagnose why /dashboard shows '—' for global market cards.

Hypotheses:
  H1. global_market rows missing entirely (collector never ran / failed)
  H2. global_market rows exist but for a different date than ai_scores latest
  H3. Symbol mismatch (e.g., 'IXIC' vs '^IXIC')
"""
from db.supabase_client import get_admin_client


def main() -> None:
    sb = get_admin_client()

    # 1. Latest ai_scores date (what dashboard uses to filter)
    latest = (
        sb.table("ai_scores").select("date").order("date", desc=True).limit(1)
          .execute().data
    )
    latest_date = latest[0]["date"] if latest else None
    print(f"[ai_scores] latest date: {latest_date}")

    # 2. Latest global_market dates per symbol
    print("\n[global_market] latest 10 rows per symbol:")
    for sym in ["^IXIC", "^GSPC", "^SOX", "^VIX", "IXIC", "GSPC", "SOX", "VIX"]:
        rows = (
            sb.table("global_market")
              .select("date, symbol, close, change_rate")
              .eq("symbol", sym)
              .order("date", desc=True)
              .limit(3)
              .execute()
              .data
        ) or []
        if rows:
            print(f"  {sym}: {[r['date'] for r in rows]}")
            for r in rows[:1]:
                print(f"    sample: close={r['close']} change_rate={r['change_rate']}")
        else:
            print(f"  {sym}: (no rows)")

    # 3. global_market rows on the dashboard's selected date
    if latest_date:
        rows = (
            sb.table("global_market")
              .select("symbol, close, change_rate")
              .eq("date", latest_date)
              .execute()
              .data
        ) or []
        print(f"\n[global_market] rows on {latest_date}: {len(rows)}")
        for r in rows:
            print(f"  {r['symbol']}: close={r['close']} change_rate={r['change_rate']}")

    # 4. Distinct symbols in global_market overall
    rows = (
        sb.table("global_market")
          .select("symbol")
          .limit(500)
          .execute()
          .data
    ) or []
    syms = sorted({r["symbol"] for r in rows})
    print(f"\n[global_market] distinct symbols (sample): {syms[:30]}")
    print(f"  total distinct: {len(syms)}")


if __name__ == "__main__":
    main()
