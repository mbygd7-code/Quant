"""Daily 07:30 KST health-check — operator-only Telegram digest.

Runs ~30 min after the daily pipeline. Pulls the same metrics that
/api/admin/data-quality + /api/admin/cost expose, formats them as a
MarkdownV2 card, and pushes via TelegramNotifier.send_admin_alert.

On Fridays an extra '주간 요약' block aggregates the last 5 KST trading
days. Send failures are logged but do NOT fail the cron job — the next
day's run remains independent.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from datetime import date as Date
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

KST = ZoneInfo("Asia/Seoul")
WEEKLY_LOOKBACK_DAYS = 7
LAST_FAILURE_LIMIT = 5

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("orchestrator.health_check")


# ──────────────────────────────────────────────────────────
# Metric collection (no Telegram side effects)
# ──────────────────────────────────────────────────────────
def collect_daily_metrics(on_date: Date) -> dict:
    from db.supabase_client import get_admin_client
    sb = get_admin_client()
    iso = on_date.isoformat()

    korea_count = len(
        sb.table("korea_market").select("ticker").eq("date", iso).execute().data or []
    )
    global_count = len(
        sb.table("global_market").select("symbol").eq("date", iso).execute().data or []
    )
    news_total = len(
        sb.table("news_items").select("id").eq("date", iso).execute().data or []
    )
    news_scored = len(
        sb.table("news_items").select("id").eq("date", iso)
          .not_.is_("sentiment_score", "null").execute().data or []
    )
    scored = len(
        sb.table("ai_scores").select("ticker").eq("date", iso).execute().data or []
    )
    notif = sb.table("notifications").select("status, error")\
        .eq("date", iso).execute().data or []

    return {
        "date": iso,
        "korea_market_rows": korea_count,
        "global_market_rows": global_count,
        "news_total": news_total,
        "news_scored": news_scored,
        "sentiment_completion_pct": (news_scored / news_total) if news_total else 0.0,
        "scored_tickers": scored,
        "notif_sent": sum(1 for r in notif if r.get("status") == "sent"),
        "notif_failed": sum(1 for r in notif if r.get("status") == "failed"),
        "recent_failures": [
            (r.get("error") or "")[:120] for r in notif
            if r.get("status") == "failed"
        ][:LAST_FAILURE_LIMIT],
    }


def collect_cost_metrics(on_date: Date) -> dict:
    from cognition.utils.cache import make_cache
    cache = make_cache()
    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6")
    calls = int(cache.get(f"llm:count:{on_date.isoformat()}:{model}") or 0)
    cap = int(os.environ.get("LLM_DAILY_CAP", "200"))
    return {
        "model": model,
        "calls_today": calls,
        "cap": cap,
        "usage_pct": (calls / cap) if cap else 0.0,
        # Per CLAUDE.md §8: sentiment ~$0.0075, report ~$0.0225 — single counter so over-estimates.
        "estimated_usd": round(calls * 0.030, 4),
    }


def collect_weekly_metrics(end_date: Date) -> dict:
    """Aggregate metrics over the last 5 KST trading days."""
    from db.supabase_client import get_admin_client
    sb = get_admin_client()
    start = end_date - timedelta(days=WEEKLY_LOOKBACK_DAYS)

    rows = (
        sb.table("ai_scores")
          .select("date, signal, final_score")
          .gte("date", start.isoformat())
          .lte("date", end_date.isoformat())
          .execute()
          .data
    ) or []

    total = len(rows)
    by_signal: dict[str, int] = {}
    for r in rows:
        by_signal[r["signal"]] = by_signal.get(r["signal"], 0) + 1
    avg_final = (
        sum(float(r["final_score"]) for r in rows) / total if total else 0.0
    )
    return {
        "from": start.isoformat(),
        "to": end_date.isoformat(),
        "total_scores": total,
        "by_signal": by_signal,
        "avg_final_score": round(avg_final, 3),
    }


# ──────────────────────────────────────────────────────────
# Markdown rendering (MarkdownV2)
# ──────────────────────────────────────────────────────────
def render_message(daily: dict, cost: dict, weekly: dict | None) -> str:
    from notifier.markdown import escape

    sentiment_pct = f"{daily['sentiment_completion_pct'] * 100:.1f}%"
    usage_pct = f"{cost['usage_pct'] * 100:.1f}%"
    cost_usd = f"{cost['estimated_usd']:.2f}"

    lines: list[str] = []
    lines.append(f"📋 *Daily Health Check* `{escape(daily['date'])}`")
    lines.append("")
    lines.append("*수집*")
    lines.append(f"\\- KR market: `{daily['korea_market_rows']}` rows")
    lines.append(f"\\- Global market: `{daily['global_market_rows']}` rows")
    lines.append(
        f"\\- News: `{daily['news_scored']}/{daily['news_total']}` scored "
        f"\\({escape(sentiment_pct)}\\)"
    )
    lines.append(f"\\- AI scores: `{daily['scored_tickers']}` tickers")
    lines.append("")
    lines.append("*LLM 비용*")
    lines.append(
        f"\\- Calls: `{cost['calls_today']}/{cost['cap']}` "
        f"\\({escape(usage_pct)}\\)"
    )
    lines.append(f"\\- Estimated USD: `${escape(cost_usd)}`")
    lines.append("")
    lines.append("*알림 발송*")
    lines.append(f"\\- ✅ `{daily['notif_sent']}` sent · ❌ `{daily['notif_failed']}` failed")
    if daily["recent_failures"]:
        lines.append("최근 실패 메시지:")
        for err in daily["recent_failures"]:
            lines.append(f"  \\- `{escape(err)}`")

    if weekly is not None:
        avg_str = str(weekly["avg_final_score"])
        lines.append("")
        lines.append(f"*주간 요약* `{escape(weekly['from'])}` ~ `{escape(weekly['to'])}`")
        lines.append(
            f"\\- 총 점수 행: `{weekly['total_scores']}`, "
            f"평균 final\\_score: `{escape(avg_str)}`"
        )
        if weekly["by_signal"]:
            lines.append("\\- 신호별 분포:")
            for sig in ("강한 관심", "관심", "관망", "주의", "위험"):
                cnt = weekly["by_signal"].get(sig, 0)
                lines.append(f"  \\- {escape(sig)}: `{cnt}`")
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────
# Send
# ──────────────────────────────────────────────────────────
async def send_health_check(text: str) -> bool:
    from notifier.telegram import TelegramNotifier
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    admin = os.environ.get("TELEGRAM_ADMIN_CHAT_ID")
    if not (token and admin):
        log.warning("TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID not set — skipping send")
        return False
    notifier = TelegramNotifier(bot_token=token, chat_ids=[admin])
    try:
        await notifier.send_admin_alert(text, level="info")
        return True
    except Exception as exc:
        log.warning("health check send failed: %s", exc)
        return False


# ──────────────────────────────────────────────────────────
# Entrypoint
# ──────────────────────────────────────────────────────────
async def _main() -> int:
    today_kst = datetime.now(tz=KST).date()
    daily = collect_daily_metrics(today_kst)
    cost = collect_cost_metrics(today_kst)
    # Friday (weekday=4) → include weekly summary block.
    weekly = collect_weekly_metrics(today_kst) if today_kst.weekday() == 4 else None

    text = render_message(daily, cost, weekly)
    log.info("Health check rendered (%d chars)", len(text))
    sent = await send_health_check(text)
    log.info("Sent=%s", sent)
    return 0


def main() -> int:
    return asyncio.run(_main())


if __name__ == "__main__":
    sys.exit(main())
