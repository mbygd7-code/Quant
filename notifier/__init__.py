"""Telegram message formatter and sender.

Public surface:
  - TelegramNotifier, render_preview, render_individual, MarkdownV2 escape
  - NotificationDispatcher (multi-channel fan-out)
  - KakaoNotifier (Phase 2 stub)
  - cmd_*, callback_handler (Application handlers)
"""
from notifier.dispatcher import NotificationDispatcher
from notifier.kakao import KakaoNotifier
from notifier.markdown import escape, escape_code
from notifier.telegram import (
    SIGNAL_EMOJI,
    TelegramNotifier,
    individual_keyboard,
    preview_keyboard,
    render_individual,
    render_preview,
)

__all__ = [
    "TelegramNotifier",
    "NotificationDispatcher",
    "KakaoNotifier",
    "render_preview", "render_individual",
    "preview_keyboard", "individual_keyboard",
    "SIGNAL_EMOJI",
    "escape", "escape_code",
]
