"""Message + notification log schemas."""
from __future__ import annotations

from datetime import date as Date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

NotifyChannel = Literal["telegram", "kakao"]
NotifyStatus = Literal["sent", "failed", "dry_run"]
MessageKind = Literal["preview", "individual", "sector", "top", "risk", "admin_alert", "ack"]


class OutgoingMessage(BaseModel):
    """Renderer output — what the notifier actually sends to a chat_id."""

    model_config = ConfigDict(extra="forbid")

    chat_id: str
    text: str
    parse_mode: Literal["MarkdownV2", "HTML", "plain"] = "MarkdownV2"
    inline_keyboard: list[list[dict]] = Field(default_factory=list)
    kind: MessageKind = "preview"


class NotificationLog(BaseModel):
    """Row written to notifications table after each send attempt."""

    model_config = ConfigDict(extra="forbid")

    date: Date
    channel: NotifyChannel
    recipient: str
    payload: dict
    status: NotifyStatus
    error: str | None = None
