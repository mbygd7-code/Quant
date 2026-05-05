"""Telegram MarkdownV2 escaping (SKILL.md section 6-4).

Telegram's MarkdownV2 reserves a long list of characters that MUST be escaped
with a leading backslash if they appear outside their formatting role:

    _ * [ ] ( ) ~ ` > # + - = | { } . !

We escape EVERY occurrence in dynamic strings (stock names, scores,
sentences). Static markup chars (like the * around a heading) are added by
the formatter, NOT through this escaper.
"""
from __future__ import annotations

# Order matters: escape backslash first to avoid double-escaping.
_RESERVED = r"_*[]()~`>#+-=|{}.!"


def escape(text: str) -> str:
    """Return MarkdownV2-safe text. None / non-str inputs become empty string."""
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    out = []
    for ch in text:
        if ch in _RESERVED:
            out.append("\\")
        out.append(ch)
    return "".join(out)


def escape_code(text: str) -> str:
    """Escape for use inside a `monospace` block. Only ` and \\ need escaping."""
    if text is None:
        return ""
    return text.replace("\\", "\\\\").replace("`", "\\`")
