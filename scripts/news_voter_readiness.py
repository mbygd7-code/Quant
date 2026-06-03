"""News-voter (방식 A) readiness check — automated go/no-go.

Scheduled ~4 weeks after the KR-news collection fix (2026-06-03) to
decide whether adding a dedicated news/catalyst voter to the 6-agent
debate is justified BY DATA, not by enthusiasm.

Two gates, both must pass for GO:

  1. COVERAGE — KR news must be flowing steadily. We require at least
     `MIN_TICKERS_WITH_NEWS` distinct KR (6-digit) tickers to have at
     least one news item in the last `WINDOW_DAYS` days. (The whole
     reason this check exists is that KR news was silently broken for
     weeks; don't build a voter on a dead feed.)

  2. SIGNAL — news_sentiment must show non-trivial predictive power.
     We read the most recent model_diagnostics rows for the
     news_sentiment_score voter and require |Spearman ρ| ≥ MIN_RHO at
     any horizon. If model_diagnostics has no news_sentiment rows yet,
     that's an automatic NO-GO (can't justify the voter blind).

Prints a structured verdict block (parsed by the workflow for the
Telegram alert) and exits 0 always — the verdict is data, not a failure.
"""
from __future__ import annotations

from datetime import date, timedelta

from db.supabase_client import fetch_all, get_admin_client

WINDOW_DAYS = 28
MIN_TICKERS_WITH_NEWS = 30   # of the ~50 watchlist, want broad coverage
MIN_RHO = 0.10               # news_sentiment must clear the noise floor

KR_TICKER = lambda s: bool(s) and s[0].isdigit()


def main() -> int:
    sb = get_admin_client()
    today = date.today()
    since = (today - timedelta(days=WINDOW_DAYS)).isoformat()

    # ── Gate 1: coverage ────────────────────────────────────────
    news = fetch_all(
        sb.table("news_items").select("related_symbols, date").gte("date", since)
    )
    kr_tickers_with_news: set[str] = set()
    kr_news_count = 0
    for r in news:
        syms = r.get("related_symbols") or []
        kr = [s for s in syms if KR_TICKER(s)]
        if kr:
            kr_news_count += 1
            kr_tickers_with_news.update(kr)
    coverage_ok = len(kr_tickers_with_news) >= MIN_TICKERS_WITH_NEWS

    # ── Gate 2: predictive signal (model_diagnostics) ──────────
    diag = fetch_all(
        sb.table("model_diagnostics")
        .select("scope_kind, scope_name, horizon_days, spearman_rho, n_pairs, run_date")
        .eq("scope_kind", "voter")
        .eq("scope_name", "news_sentiment_score")
        .order("run_date", desc=True)
    )
    # Most recent run's rows only.
    best_rho = None
    best_h = None
    n_pairs = 0
    if diag:
        latest_run = diag[0]["run_date"]
        for r in diag:
            if r["run_date"] != latest_run:
                continue
            rho = r.get("spearman_rho")
            if rho is None:
                continue
            if best_rho is None or abs(rho) > abs(best_rho):
                best_rho = rho
                best_h = r["horizon_days"]
                n_pairs = r.get("n_pairs", 0)
    signal_ok = best_rho is not None and abs(best_rho) >= MIN_RHO

    go = coverage_ok and signal_ok

    # ── Verdict block (workflow greps VERDICT: / DETAIL:) ──────
    print("=" * 56)
    print(f"VERDICT: {'GO' if go else 'NO-GO'}")
    print(
        f"DETAIL: coverage {len(kr_tickers_with_news)}/{MIN_TICKERS_WITH_NEWS} KR tickers "
        f"with news in {WINDOW_DAYS}d ({kr_news_count} items) "
        f"{'✅' if coverage_ok else '❌'} | "
        + (
            f"news_sentiment ρ={best_rho:+.3f} @t+{best_h} (n={n_pairs}) "
            f"{'✅' if signal_ok else '❌ <' + str(MIN_RHO)}"
            if best_rho is not None
            else "news_sentiment ρ=없음 (model_diagnostics 미수집) ❌"
        )
    )
    if go:
        print(
            "DETAIL: → 뉴스 voter(방식 A) 도입 근거 충족. 전용 voter(Lynch, 5-10% 가중) "
            "구현 권장 — InsufficientData 기권/priced_in 감쇠/scorer 가중 재조정/cache 1블록/"
            "금지어 sanitizer/백테스트 검증 가드 포함, 새 브랜치+PR로."
        )
    else:
        print(
            "DETAIL: → 아직 도입 보류. 위 실패 게이트가 해소될 때까지 6전문가 토론은 "
            "현행 유지(뉴스는 8요소 scorer에만)."
        )
    print("=" * 56)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
