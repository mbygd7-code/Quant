"""TelegramNotifier — render + send messages via python-telegram-bot.

Three send_ methods cover the user-facing surface:
  - send_preview      daily 5-stock summary (top picks + sector temps)
  - send_individual   per-stock detail card (pos 3 + risk 2 + comment)
  - send_admin_alert  operator notification (failures, cost overruns)

Safety (CLAUDE.md sections A/B/H):
  - Forbidden-word check on report text BEFORE rendering — defense in depth
  - Disclaimer auto-appended to user-visible messages
  - DRY_RUN env writes to logs/ instead of sending
  - Auto-fallback to plain text if MarkdownV2 raises BadRequest
  - 4096-char message split
"""
from __future__ import annotations

import logging
import os
from datetime import date as Date
from pathlib import Path

from notifier.__schemas__.messages import OutgoingMessage
from notifier.markdown import escape
from signals.__schemas__.report import (
    DISCLAIMER,
    StockReport,
    validate_report,
    with_disclaimer,
)

log = logging.getLogger("notifier.telegram")

TELEGRAM_MAX_MSG = 4096
LOG_DIR = Path(os.environ.get("LOG_DIR", "logs"))

SIGNAL_EMOJI = {
    "강한 관심": "🟢", "관심": "🔵", "관망": "⚪",
    "주의": "🟡", "위험": "🔴",
}


def _is_dry_run() -> bool:
    return os.environ.get("DRY_RUN", "false").lower() == "true"


# ──────────────────────────────────────────────────────────
# Renderers (pure functions — easy to unit-test, no I/O)
# ──────────────────────────────────────────────────────────
def render_preview(
    on_date: Date,
    market: dict[str, dict],
    sector_counts: dict[str, dict[str, int]],
    top5: list[dict],
) -> str:
    """Build MarkdownV2 daily preview text."""
    lines: list[str] = []
    lines.append(f"📊 *{escape(on_date.isoformat())} 한국장 프리뷰*")
    lines.append("")
    lines.append("🌡 *글로벌 온도*")
    if not market:
        lines.append(escape("- 시장 데이터 없음"))
    else:
        for symbol in ("^IXIC", "^SOX", "^VIX", "USDKRW"):
            row = market.get(symbol)
            if not row:
                continue
            chg = row.get("change_rate")
            chg_str = f"{chg * 100:+.2f}%" if chg is not None else "-"
            lines.append(f"\\- {escape(symbol)} {escape(chg_str)}")
    lines.append("")
    lines.append("🏭 *섹터 온도*")
    for sector, counts in sorted(sector_counts.items()):
        emoji = "🟢" if counts.get("강한 관심", 0) + counts.get("관심", 0) > 2 else "⚪"
        lines.append(
            f"{emoji} {escape(sector)} \\(🟢{counts.get('강한 관심', 0)} "
            f"🔵{counts.get('관심', 0)} ⚪{counts.get('관망', 0)} "
            f"🟡{counts.get('주의', 0)} 🔴{counts.get('위험', 0)}\\)"
        )
    lines.append("")
    lines.append("🔝 *상위 5 종목*")
    for i, row in enumerate(top5[:5], start=1):
        emoji = SIGNAL_EMOJI.get(row["signal"], "⚪")
        name = row.get("name") or row["ticker"]
        score_str = f"{row['final_score']:.2f}"
        lines.append(
            f"{i}\\. {emoji} {escape(name)} `{escape(row['ticker'])}` `{escape(score_str)}`"
        )
    lines.append("")
    lines.append(escape(DISCLAIMER.strip()))
    return "\n".join(lines)


def render_individual(
    *,
    name: str,
    ticker: str,
    sector: str,
    signal: str,
    final_score: float,
    report: StockReport,
) -> str:
    """Build MarkdownV2 single-stock detail card."""
    # Defense in depth — re-validate that LLM output has no forbidden words.
    validate_report(report)
    finalized = with_disclaimer(report)

    emoji = SIGNAL_EMOJI.get(signal, "⚪")
    # 위험 / 주의 강조 — message head warning per CLAUDE.md UX
    head_alert = "⚠️ " if signal in ("위험", "주의") else ""

    lines: list[str] = []
    lines.append(
        f"{head_alert}{emoji} *{escape(name)}* `{escape(ticker)}` "
        f"\\| {escape(sector)}"
    )
    lines.append(
        f"신호: *{escape(signal)}* \\(점수 {escape(f'{final_score:.2f}')}\\)"
    )
    lines.append("")
    lines.append("✅ *긍정 요인*")
    for f in finalized.positive_factors:
        lines.append(f"• {escape(f)}")
    lines.append("")
    lines.append("⚠️ *리스크*")
    for f in finalized.risk_factors:
        lines.append(f"• {escape(f)}")
    lines.append("")
    lines.append("💬 *AI 코멘트*")
    lines.append(escape(finalized.comment))
    return "\n".join(lines)


# ──────────────────────────────────────────────────────────
# Inline keyboards
# ──────────────────────────────────────────────────────────
def preview_keyboard(top5: list[dict]) -> list[list[dict]]:
    """Build a keyboard with 'detail' buttons for each top-5 stock."""
    rows: list[list[dict]] = [
        [
            {"text": "📋 전체 종목", "callback_data": "list_all:0"},
            {"text": "🏭 섹터별 보기", "callback_data": "by_sector"},
        ],
    ]
    pair: list[dict] = []
    for row in top5[:4]:
        pair.append({
            "text": f"{SIGNAL_EMOJI.get(row['signal'], '⚪')} {row.get('name') or row['ticker']}",
            "callback_data": f"detail:{row['ticker']}",
        })
        if len(pair) == 2:
            rows.append(pair)
            pair = []
    if pair:
        rows.append(pair)
    rows.append([
        {"text": "⚠️ 위험 신호", "callback_data": "risk"},
        {"text": "⚙️ 설정", "callback_data": "settings"},
    ])
    return rows


def individual_keyboard(ticker: str) -> list[list[dict]]:
    return [
        [
            {"text": "📰 관련 뉴스", "callback_data": f"news:{ticker}"},
            {"text": "🏠 메인으로", "callback_data": "home"},
        ],
        [
            {"text": "⬅️ 이전", "callback_data": f"prev:{ticker}"},
            {"text": "➡️ 다음", "callback_data": f"next:{ticker}"},
        ],
    ]


# ──────────────────────────────────────────────────────────
# Notifier — actual send (or DRY_RUN file write)
# ──────────────────────────────────────────────────────────
class TelegramNotifier:
    def __init__(self, bot_token: str, chat_ids: list[str], bot=None) -> None:
        self._token = bot_token
        self.chat_ids = chat_ids
        self._bot = bot                      # injectable for tests

    def _ensure_bot(self):
        if self._bot is None:
            from telegram import Bot  # lazy import (heavy)
            self._bot = Bot(token=self._token)
        return self._bot

    # ── Public send_* ──────────────────────────────────
    async def send_preview(
        self, on_date: Date, market: dict[str, dict],
        sector_counts: dict[str, dict[str, int]], top5: list[dict],
    ) -> list[OutgoingMessage]:
        text = render_preview(on_date, market, sector_counts, top5)
        kb = preview_keyboard(top5)
        return await self._broadcast(text, kb, kind="preview", on_date=on_date)

    async def send_individual(
        self, chat_id: str, *,
        name: str, ticker: str, sector: str,
        signal: str, final_score: float, report: StockReport,
        on_date: Date,
    ) -> OutgoingMessage:
        text = render_individual(
            name=name, ticker=ticker, sector=sector,
            signal=signal, final_score=final_score, report=report,
        )
        kb = individual_keyboard(ticker)
        msg = OutgoingMessage(chat_id=chat_id, text=text, inline_keyboard=kb,
                              kind="individual")
        await self._send_one(msg, on_date)
        return msg

    async def send_admin_alert(
        self, message: str, *, level: str = "info", on_date: Date | None = None,
    ) -> OutgoingMessage | None:
        admin = os.environ.get("TELEGRAM_ADMIN_CHAT_ID")
        if not admin:
            log.warning("TELEGRAM_ADMIN_CHAT_ID unset — skipping admin alert")
            return None
        emoji = {"info": "ℹ️", "warn": "⚠️", "error": "🚨"}.get(level, "ℹ️")
        text = f"{emoji} *Admin*\n{escape(message)}"
        msg = OutgoingMessage(chat_id=admin, text=text, kind="admin_alert")
        await self._send_one(msg, on_date or _today_kst())
        return msg

    # ── Internals ──────────────────────────────────────
    async def _broadcast(
        self, text: str, keyboard: list[list[dict]], *,
        kind: str, on_date: Date,
    ) -> list[OutgoingMessage]:
        sent: list[OutgoingMessage] = []
        for chat_id in self.chat_ids:
            msg = OutgoingMessage(
                chat_id=chat_id, text=text, inline_keyboard=keyboard, kind=kind,
            )
            await self._send_one(msg, on_date)
            sent.append(msg)
        return sent

    async def _send_one(self, msg: OutgoingMessage, on_date: Date) -> None:
        if _is_dry_run():
            self._write_dry_run(msg, on_date)
            return

        bot = self._ensure_bot()
        chunks = _split_message(msg.text, TELEGRAM_MAX_MSG)
        for i, chunk in enumerate(chunks):
            kb = self._to_inline_keyboard(msg.inline_keyboard) if i == len(chunks) - 1 else None
            try:
                await bot.send_message(
                    chat_id=msg.chat_id, text=chunk,
                    parse_mode="MarkdownV2", reply_markup=kb,
                )
            except Exception as exc:
                log.warning("MarkdownV2 send failed (%s) — falling back to plain text", exc)
                await bot.send_message(
                    chat_id=msg.chat_id, text=_strip_markdown(chunk), reply_markup=kb,
                )

    @staticmethod
    def _to_inline_keyboard(rows: list[list[dict]]):
        if not rows:
            return None
        from telegram import InlineKeyboardButton, InlineKeyboardMarkup
        return InlineKeyboardMarkup([
            [InlineKeyboardButton(text=b["text"], callback_data=b["callback_data"]) for b in row]
            for row in rows
        ])

    @staticmethod
    def _write_dry_run(msg: OutgoingMessage, on_date: Date) -> None:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"telegram_{msg.kind}_{on_date.isoformat()}.txt"
        with path.open("a", encoding="utf-8") as fh:
            fh.write(f"\n=== to chat_id={msg.chat_id} ({msg.parse_mode}) ===\n")
            fh.write(msg.text)
            fh.write("\n")
            if msg.inline_keyboard:
                fh.write(f"[buttons] {msg.inline_keyboard}\n")


# ──────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────
def _split_message(text: str, limit: int) -> list[str]:
    """Split on line boundaries to keep MarkdownV2 valid across chunks."""
    if len(text) <= limit:
        return [text]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for line in text.split("\n"):
        line_len = len(line) + 1
        if current_len + line_len > limit and current:
            chunks.append("\n".join(current))
            current, current_len = [line], line_len
        else:
            current.append(line)
            current_len += line_len
    if current:
        chunks.append("\n".join(current))
    return chunks


def _strip_markdown(text: str) -> str:
    """Best-effort plain-text fallback when MarkdownV2 send fails."""
    out = []
    skip = False
    for ch in text:
        if ch == "\\":
            skip = True
            continue
        if ch in "*_`":
            continue
        if skip:
            skip = False
        out.append(ch)
    return "".join(out)


def _today_kst() -> Date:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    return datetime.now(tz=ZoneInfo("Asia/Seoul")).date()
