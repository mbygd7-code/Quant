"""Telegram command + callback handlers.

Same handler functions are shared between local polling (notifier.bot_runner)
and Vercel webhook (apps/api/routes/telegram_webhook).

Edit operations are explicitly NOT supported here per CLAUDE.md section H —
any /edit_* attempt responds with 'use the web app'.
"""
from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

from db.supabase_client import get_admin_client
from notifier.markdown import escape
from notifier.telegram import (
    SIGNAL_EMOJI,
    individual_keyboard,
    preview_keyboard,
    render_individual,
    render_preview,
)
from signals.__schemas__.report import StockReport

if TYPE_CHECKING:
    from telegram import Update
    from telegram.ext import ContextTypes

log = logging.getLogger("notifier.handlers")

VALID_SECTORS = ("반도체", "2차전지", "자동차", "바이오/헬스", "인터넷/AI")
WEB_APP_URL = os.environ.get("WEB_APP_URL", "https://quantsignal.app")


# ──────────────────────────────────────────────────────────
# Command handlers
# ──────────────────────────────────────────────────────────
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    text = (
        f"👋 *QuantSignal에 오신 것을 환영합니다*\n\n"
        f"매 거래일 06:30 KST 한국장 시작 전 글로벌 신호 프리뷰를 받아보실 수 있습니다\\.\n\n"
        f"먼저 웹앱에서 가입 후 발급된 코드로 연동해주세요:\n"
        f"`{escape(WEB_APP_URL)}`\n\n"
        f"명령어: /today /stock /sector /top /risk /help\n\n"
        f"본인 chat\\_id: `{chat_id}`"
    )
    await update.message.reply_text(text, parse_mode="MarkdownV2")


async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = str(update.effective_chat.id)
    if not context.args or len(context.args[0]) != 6 or not context.args[0].isdigit():
        await update.message.reply_text(
            "사용법: /link 123456 \\(웹앱에서 발급한 6자리 숫자 코드\\)",
            parse_mode="MarkdownV2",
        )
        return
    code = context.args[0]

    sb = get_admin_client()
    # The link_telegram RPC validates code + expiry + updates profiles row.
    # Caller must already have a profile row keyed to the same chat_id later;
    # here we look up by code. (RPC signature defined in migration 6.)
    try:
        # Find the profile that issued this code (admin RPC call).
        profile = (
            sb.table("profiles")
              .select("id, link_code_expires_at, telegram_link_code")
              .eq("telegram_link_code", code)
              .limit(1)
              .execute()
              .data
        )
        if not profile:
            await update.message.reply_text("❌ 코드가 잘못되었거나 만료되었습니다\\.",
                                            parse_mode="MarkdownV2")
            return
        result = sb.rpc("link_telegram", {
            "p_user_id": profile[0]["id"],
            "p_link_code": code,
            "p_chat_id": chat_id,
        }).execute()
        rows = result.data or []
        if rows and rows[0].get("success"):
            await update.message.reply_text("✅ 연동 완료\\! 내일 06:30부터 프리뷰가 발송됩니다\\.",
                                            parse_mode="MarkdownV2")
        else:
            msg = (rows[0]["message"] if rows else "연동 실패")
            await update.message.reply_text(f"❌ {escape(msg)}", parse_mode="MarkdownV2")
    except Exception as exc:
        log.warning("link RPC failed: %s", exc)
        await update.message.reply_text("⚠️ 연동 처리 중 오류가 발생했습니다\\.",
                                        parse_mode="MarkdownV2")


async def cmd_today(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    on_date = _today_kst()
    sb = get_admin_client()
    market, sector_counts, top5 = _gather_preview(sb, on_date)
    text = render_preview(on_date, market, sector_counts, top5)
    keyboard = preview_keyboard(top5)
    await update.message.reply_text(
        text, parse_mode="MarkdownV2",
        reply_markup=_inline_keyboard(keyboard),
    )


async def cmd_stock(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("사용법: /stock 005930", parse_mode="MarkdownV2")
        return
    ticker = context.args[0]
    if not (ticker.isdigit() and len(ticker) == 6):
        await update.message.reply_text("ticker는 6자리 숫자여야 합니다\\.",
                                        parse_mode="MarkdownV2")
        return

    text = await _build_stock_detail(ticker)
    if text is None:
        await update.message.reply_text(
            f"`{escape(ticker)}` 의 오늘자 데이터가 없습니다\\.",
            parse_mode="MarkdownV2",
        )
        return
    await update.message.reply_text(
        text, parse_mode="MarkdownV2",
        reply_markup=_inline_keyboard(individual_keyboard(ticker)),
    )


async def cmd_sector(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args or context.args[0] not in VALID_SECTORS:
        valid = ", ".join(escape(s) for s in VALID_SECTORS)
        await update.message.reply_text(
            f"사용 가능한 섹터: {valid}", parse_mode="MarkdownV2",
        )
        return
    sector = context.args[0]
    on_date = _today_kst()
    rows = _fetch_sector_rows(sector, on_date)
    if not rows:
        await update.message.reply_text(
            f"`{escape(sector)}` 섹터 오늘 데이터 없음", parse_mode="MarkdownV2",
        )
        return
    lines = [f"🏭 *{escape(sector)}* 섹터"]
    for row in rows:
        emoji = SIGNAL_EMOJI.get(row["signal"], "⚪")
        name = row.get("stocks", {}).get("name") or row["ticker"]
        score_str = f"{row['final_score']:.2f}"
        lines.append(
            f"{emoji} {escape(name)} `{escape(row['ticker'])}` "
            f"`{escape(score_str)}` \\| {escape(row['signal'])}"
        )
    await update.message.reply_text("\n".join(lines), parse_mode="MarkdownV2")


async def cmd_top(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    on_date = _today_kst()
    sb = get_admin_client()
    rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, stocks(name)")
          .eq("date", on_date.isoformat())
          .order("final_score", desc=True)
          .limit(5)
          .execute()
          .data
    ) or []
    lines = ["🔝 *상위 5 종목*"]
    for i, row in enumerate(rows, start=1):
        emoji = SIGNAL_EMOJI.get(row["signal"], "⚪")
        name = (row.get("stocks") or {}).get("name") or row["ticker"]
        score_str = f"{row['final_score']:.2f}"
        lines.append(
            f"{i}\\. {emoji} {escape(name)} `{escape(row['ticker'])}` "
            f"`{escape(score_str)}`"
        )
    await update.message.reply_text("\n".join(lines), parse_mode="MarkdownV2")


async def cmd_risk(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    on_date = _today_kst()
    sb = get_admin_client()
    rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, stocks(name)")
          .eq("date", on_date.isoformat())
          .in_("signal", ["주의", "위험"])
          .order("final_score", desc=False)
          .execute()
          .data
    ) or []
    if not rows:
        await update.message.reply_text("⚠️ 위험·주의 신호 종목 없음", parse_mode="MarkdownV2")
        return
    lines = ["⚠️ *위험 신호 종목*"]
    for row in rows:
        emoji = SIGNAL_EMOJI.get(row["signal"], "⚠️")
        name = (row.get("stocks") or {}).get("name") or row["ticker"]
        score_str = f"{row['final_score']:.2f}"
        lines.append(
            f"{emoji} {escape(name)} `{escape(row['ticker'])}` "
            f"`{escape(score_str)}` \\| {escape(row['signal'])}"
        )
    await update.message.reply_text("\n".join(lines), parse_mode="MarkdownV2")


async def cmd_feedback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """3단계 피드백 흐름 시작 — 정확도 → 유용성 → 코멘트(선택).

    Stateless: 모든 단계의 응답은 callback_data에 인코딩되어
    Vercel webhook의 무상태 환경에서도 동작한다.
    """
    chat_id = str(update.effective_chat.id)
    sb = get_admin_client()
    profile = (
        sb.table("profiles").select("id").eq("telegram_chat_id", chat_id)
          .limit(1).execute().data
    )
    if not profile:
        await update.message.reply_text(
            "먼저 /link 명령으로 웹앱과 연동해주세요\\.", parse_mode="MarkdownV2",
        )
        return

    # If user provided text inline (legacy syntax: /feedback 좋았어요),
    # save as a comment-only row immediately.
    if context.args:
        comment = " ".join(context.args)
        sb.table("user_feedback").insert({
            "user_id": profile[0]["id"],
            "date": _today_kst().isoformat(),
            "comment": comment,
            "source": "telegram",
        }).execute()
        await update.message.reply_text("🙏 피드백 감사합니다\\!", parse_mode="MarkdownV2")
        return

    # Step 1: 정확도 1~5 inline buttons
    rows = [[{"text": f"{n} {'⭐' * n}", "callback_data": f"fb:acc:{n}"} for n in (1, 2)],
            [{"text": f"{n} {'⭐' * n}", "callback_data": f"fb:acc:{n}"} for n in (3, 4)],
            [{"text": f"5 {'⭐' * 5}", "callback_data": "fb:acc:5"}]]
    await update.message.reply_text(
        "📊 *피드백 \\(1/3\\) — 정확도*\n오늘 신호의 정확도는 어땠나요?",
        parse_mode="MarkdownV2",
        reply_markup=_inline_keyboard(rows),
    )


async def _feedback_step_usefulness(update: Update, accuracy: int) -> None:
    rows = [[{"text": f"{n} {'⭐' * n}", "callback_data": f"fb:use:{accuracy}:{n}"} for n in (1, 2)],
            [{"text": f"{n} {'⭐' * n}", "callback_data": f"fb:use:{accuracy}:{n}"} for n in (3, 4)],
            [{"text": f"5 {'⭐' * 5}", "callback_data": f"fb:use:{accuracy}:5"}]]
    await update.callback_query.edit_message_text(
        "📊 *피드백 \\(2/3\\) — 유용성*\n실제 의사결정에 얼마나 유용했나요?",
        parse_mode="MarkdownV2",
        reply_markup=_inline_keyboard(rows),
    )


async def _feedback_save(
    chat_id: str, accuracy: int, usefulness: int,
) -> tuple[bool, str]:
    sb = get_admin_client()
    profile = (
        sb.table("profiles").select("id").eq("telegram_chat_id", chat_id)
          .limit(1).execute().data
    )
    if not profile:
        return False, "프로필을 찾을 수 없습니다."
    sb.table("user_feedback").insert({
        "user_id":          profile[0]["id"],
        "date":             _today_kst().isoformat(),
        "accuracy_score":   accuracy,
        "usefulness_score": usefulness,
        "source":           "telegram",
    }).execute()
    return True, "ok"


async def cmd_feedback_note(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """가장 최근(1시간 내) 피드백 행에 코멘트 추가."""
    if not context.args:
        await update.message.reply_text(
            "사용법: /feedback\\_note 코멘트 내용",
            parse_mode="MarkdownV2",
        )
        return
    chat_id = str(update.effective_chat.id)
    sb = get_admin_client()
    profile = (
        sb.table("profiles").select("id").eq("telegram_chat_id", chat_id)
          .limit(1).execute().data
    )
    if not profile:
        await update.message.reply_text(
            "먼저 /link 명령으로 웹앱과 연동해주세요\\.", parse_mode="MarkdownV2",
        )
        return

    from datetime import datetime, timedelta, timezone
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    recent = (
        sb.table("user_feedback")
          .select("id, created_at, comment")
          .eq("user_id", profile[0]["id"])
          .eq("source", "telegram")
          .gte("created_at", one_hour_ago)
          .order("created_at", desc=True)
          .limit(1)
          .execute()
          .data
    )
    comment = " ".join(context.args)
    if recent:
        sb.table("user_feedback").update({
            "comment": comment,
        }).eq("id", recent[0]["id"]).execute()
    else:
        # Comment-only feedback (no rating yet)
        sb.table("user_feedback").insert({
            "user_id": profile[0]["id"],
            "date":    _today_kst().isoformat(),
            "comment": comment,
            "source":  "telegram",
        }).execute()
    await update.message.reply_text("🙏 코멘트 저장 완료\\!", parse_mode="MarkdownV2")


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    text = (
        "*명령어*\n"
        "/today \\- 오늘 프리뷰\n"
        "/stock 005930 \\- 종목 상세\n"
        "/sector 반도체 \\- 섹터 요약\n"
        "/top \\- 상위 5\n"
        "/risk \\- 위험 종목\n"
        "/feedback \\- 피드백 \\(3단계 인터랙티브\\)\n"
        "/feedback\\_note 코멘트 \\- 피드백 코멘트 추가\n"
        "/link 123456 \\- 웹앱 연동\n"
        "/help \\- 도움말"
    )
    await update.message.reply_text(text, parse_mode="MarkdownV2")


# ──────────────────────────────────────────────────────────
# Callback handler
# ──────────────────────────────────────────────────────────
async def callback_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()                 # acknowledge to remove spinner
    data = query.data or ""

    action, _, arg = data.partition(":")

    if action == "detail" and arg:
        text = await _build_stock_detail(arg)
        if text is None:
            await query.edit_message_text(
                f"`{escape(arg)}` 의 오늘자 데이터가 없습니다\\.",
                parse_mode="MarkdownV2",
            )
            return
        await query.edit_message_text(
            text, parse_mode="MarkdownV2",
            reply_markup=_inline_keyboard(individual_keyboard(arg)),
        )
        return

    if action == "by_sector":
        rows = [
            [{"text": s, "callback_data": f"sector:{s}"}]
            for s in VALID_SECTORS
        ]
        await query.edit_message_text(
            "🏭 *섹터 선택*", parse_mode="MarkdownV2",
            reply_markup=_inline_keyboard(rows),
        )
        return

    if action == "sector" and arg:
        on_date = _today_kst()
        rows = _fetch_sector_rows(arg, on_date)
        if not rows:
            await query.edit_message_text("데이터 없음", parse_mode="MarkdownV2")
            return
        lines = [f"🏭 *{escape(arg)}*"]
        for row in rows:
            emoji = SIGNAL_EMOJI.get(row["signal"], "⚪")
            name = (row.get("stocks") or {}).get("name") or row["ticker"]
            score_str = f"{row['final_score']:.2f}"
            lines.append(
                f"{emoji} {escape(name)} `{escape(row['ticker'])}` "
                f"`{escape(score_str)}`"
            )
        await query.edit_message_text("\n".join(lines), parse_mode="MarkdownV2")
        return

    if action == "home":
        await cmd_today(update, context)
        return

    if action == "settings":
        await query.edit_message_text(
            f"⚙️ 설정은 웹앱에서 관리됩니다:\n`{escape(WEB_APP_URL + '/settings')}`",
            parse_mode="MarkdownV2",
        )
        return

    if action == "risk":
        await cmd_risk(update, context)
        return

    if action == "news" and arg:
        sb = get_admin_client()
        rows = (
            sb.table("news_items")
              .select("title, url, sentiment_score")
              .eq("date", _today_kst().isoformat())
              .contains("related_symbols", [arg])
              .order("sentiment_score", desc=True)
              .limit(3)
              .execute()
              .data
        ) or []
        if not rows:
            await query.edit_message_text("관련 뉴스 없음", parse_mode="MarkdownV2")
            return
        lines = [f"📰 *{escape(arg)} 관련 뉴스*"]
        for r in rows:
            score = r.get("sentiment_score") or 0
            score_str = f"{score:.2f}"
            lines.append(
                f"\\- \\({escape(score_str)}\\) [{escape(r['title'][:60])}]({r['url']})"
            )
        await query.edit_message_text(
            "\n".join(lines), parse_mode="MarkdownV2",
            disable_web_page_preview=True,
        )
        return

    # ── Feedback flow callbacks ──
    if action == "fb":
        # data shapes:
        #   fb:acc:{N}              → step 1 클릭 → step 2 표시
        #   fb:use:{accuracy}:{N}   → step 2 클릭 → 저장 + step 3 안내
        sub, _, rest = arg.partition(":")
        if sub == "acc" and rest.isdigit() and 1 <= int(rest) <= 5:
            await _feedback_step_usefulness(update, int(rest))
            return
        if sub == "use":
            acc_str, _, use_str = rest.partition(":")
            if acc_str.isdigit() and use_str.isdigit():
                acc = int(acc_str)
                use = int(use_str)
                if 1 <= acc <= 5 and 1 <= use <= 5:
                    chat_id = str(update.effective_chat.id)
                    ok, msg = await _feedback_save(chat_id, acc, use)
                    if ok:
                        await query.edit_message_text(
                            "✅ *피드백 저장 완료* \\(3/3\\)\n\n"
                            f"정확도 {acc}⭐ · 유용성 {use}⭐\n\n"
                            "추가 코멘트가 있으면 1시간 내에:\n"
                            "`/feedback_note 코멘트 내용`",
                            parse_mode="MarkdownV2",
                        )
                    else:
                        await query.edit_message_text(
                            f"❌ {escape(msg)}", parse_mode="MarkdownV2",
                        )
                    return
        await query.edit_message_text(
            "잘못된 피드백 응답입니다\\.", parse_mode="MarkdownV2",
        )
        return

    # prev / next / unknown — fallback
    await query.edit_message_text("알 수 없는 명령입니다\\.", parse_mode="MarkdownV2")


# ──────────────────────────────────────────────────────────
# Internals
# ──────────────────────────────────────────────────────────
def _today_kst():
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.now(tz=ZoneInfo("Asia/Seoul")).date()


def _inline_keyboard(rows: list[list[dict]]):
    if not rows:
        return None
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(text=b["text"], callback_data=b["callback_data"]) for b in row]
        for row in rows
    ])


def _gather_preview(sb, on_date):
    market_rows = (
        sb.table("global_market")
          .select("symbol, close, change_rate")
          .eq("date", on_date.isoformat())
          .in_("symbol", ["^IXIC", "^GSPC", "^SOX", "^VIX", "USDKRW"])
          .execute()
          .data
    ) or []
    market = {r["symbol"]: r for r in market_rows}

    score_rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, stocks(name, sector)")
          .eq("date", on_date.isoformat())
          .execute()
          .data
    ) or []

    sector_counts: dict[str, dict[str, int]] = {}
    for r in score_rows:
        sector = (r.get("stocks") or {}).get("sector") or "기타"
        sector_counts.setdefault(sector, {})
        sector_counts[sector][r["signal"]] = sector_counts[sector].get(r["signal"], 0) + 1

    top5 = sorted(score_rows, key=lambda r: -r["final_score"])[:5]
    top5 = [
        {
            "ticker": r["ticker"], "signal": r["signal"],
            "final_score": r["final_score"],
            "name": (r.get("stocks") or {}).get("name") or r["ticker"],
        }
        for r in top5
    ]
    return market, sector_counts, top5


def _fetch_sector_rows(sector: str, on_date):
    sb = get_admin_client()
    return (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, stocks(name, sector)")
          .eq("date", on_date.isoformat())
          .order("final_score", desc=True)
          .execute()
          .data
    ) or []


async def _build_stock_detail(ticker: str) -> str | None:
    on_date = _today_kst()
    sb = get_admin_client()
    rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, rationale_json, stocks(name, sector)")
          .eq("date", on_date.isoformat())
          .eq("ticker", ticker)
          .limit(1)
          .execute()
          .data
    )
    if not rows:
        return None
    row = rows[0]
    stock = row.get("stocks") or {}
    rationale = row.get("rationale_json") or {}
    # Build a StockReport-shaped object from rationale_json (Prompt 07 wrote it).
    try:
        report = StockReport.model_validate({
            "positive_factors": rationale.get("positive_factors") or rationale.get("evidence", [])[:3],
            "risk_factors":     rationale.get("risk_factors") or rationale.get("risks", [])[:2],
            "comment":          rationale.get("comment") or "데이터 준비 중입니다.",
        })
    except Exception as exc:
        log.warning("Bad rationale_json for %s: %s", ticker, exc)
        return None

    return render_individual(
        name=stock.get("name") or ticker,
        ticker=ticker,
        sector=stock.get("sector") or "기타",
        signal=row["signal"],
        final_score=row["final_score"],
        report=report,
    )
