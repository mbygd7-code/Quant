"""CLAUDE.md §3-A forbidden-word guard.

The legacy ``signals/report.py`` has its own copy of this for the
Phase-1 narrative + risk template. We deliberately ship a separate
copy here rather than import from ``signals/`` because:

  * ``agents/`` must stay independent of legacy modules so neither
    side's refactor breaks the other.
  * The 8-character outputs may evolve their banned-word list (e.g.
    Soros adding '확정 진단' / '단정' in M4) without touching legacy.
"""
from __future__ import annotations

#: Words that must never appear in user-facing narratives.
#: Matches the SKILL.md spec; mirrored in ``signals/report.py``.
FORBIDDEN_WORDS: tuple[str, ...] = (
    "매수",
    "매도",
    "강력 추천",
    "오늘 오른다",
    "오늘 내린다",
    "확정",
    "보장",
    "100%",
)

#: Legitimate market/technical compounds that CONTAIN '매수'/'매도' as a
#: substring but are DESCRIPTIVE vocabulary, not trade recommendations.
#:
#: The guard used to be a naive substring scan, so it false-positived on
#: every one of these — most damagingly on '과매수'/'과매도', which Turing's
#: own system prompt instructs it to use ("기술적 과매수 영역에 진입").
#: That redacted ~70% of Turing's narratives (768 rows) into the internal
#: '[narrative redacted …]' placeholder that leaked to the UI.
#:
#: This is NOT a relaxation of CLAUDE.md §3-A: a standalone '매수'/'매도'
#: and every recommendation phrasing ('매수하세요', '매수 추천', '매수 신호',
#: '지금 매수') still trips the guard. We only exempt these fixed compounds.
#: Adding a word here is a deliberate change — keep it auditable and in sync
#: with the TS mirror (apps/web/lib/agents/sanitize.ts) and signals/report.py.
ALLOWED_COMPOUNDS: tuple[str, ...] = (
    "과매수", "과매도",      # RSI overbought / oversold (technical state)
    "순매수", "순매도",      # net buy / net sell (foreign·institution flows)
    "매수세", "매도세",      # buying / selling pressure
    "매수잔량", "매도잔량",  # order-book residual quantity (호가창)
    "매수호가", "매도호가",  # bid / ask price
    "매수주체", "매도주체",  # buyer / seller (수급 주체)
    "매수우위", "매도우위",  # buy-side / sell-side dominance
)


def _is_allowed_compound(narrative: str, word: str, pos: int) -> bool:
    """True when the banned ``word`` found at ``pos`` is actually part of a
    legitimate descriptive compound (과매수, 순매수, 매수세 …) rather than a
    standalone trade recommendation."""
    for compound in ALLOWED_COMPOUNDS:
        off = compound.find(word)
        if off < 0:
            continue
        start = pos - off
        if start >= 0 and narrative[start : start + len(compound)] == compound:
            return True
    return False


class ForbiddenWordError(ValueError):
    """Raised by :func:`sanitize_narrative` when a banned word is
    found. Carries the offending word + first match index so callers
    can surface a useful error message."""

    def __init__(self, word: str, position: int, narrative: str) -> None:
        self.word = word
        self.position = position
        self.narrative = narrative
        super().__init__(f"forbidden word {word!r} at position {position}")


def forbidden_words_violations(narrative: str) -> list[tuple[str, int]]:
    """Return ``(word, position)`` tuples for every banned word.

    Empty list = clean. Used by tests to enumerate violations without
    raising."""
    out: list[tuple[str, int]] = []
    for word in FORBIDDEN_WORDS:
        idx = 0
        while True:
            found = narrative.find(word, idx)
            if found < 0:
                break
            if not _is_allowed_compound(narrative, word, found):
                out.append((word, found))
            idx = found + len(word)
    return out


def sanitize_narrative(narrative: str) -> str:
    """Strict gate. Returns ``narrative`` unchanged if clean; raises
    :class:`ForbiddenWordError` otherwise.

    No fuzzy matching — if a banned word appears anywhere in the text,
    the LLM mis-fired and the right move is to retry rather than to
    silently scrub. Scrubbing would let bad outputs ship under the
    veil of compliance.
    """
    violations = forbidden_words_violations(narrative)
    if violations:
        word, pos = violations[0]
        raise ForbiddenWordError(word, pos, narrative)
    return narrative


def sanitize_narrative_safe(
    narrative: str, *, redaction_template: str | None = None
) -> str:
    """Non-fatal variant for *aggregator* narratives (e.g. Soros).

    Per-character narratives stay strict — if Graham/Dow/Taleb produce
    a banned word, dropping that one voter's row is the right outcome
    (per-character isolation in the cycle orchestrator).

    Soros, however, aggregates the whole signal: a single forbidden
    word in its narrative would currently delete every voter's
    contribution from the CSV / final_signals row. That's a worse
    failure than emitting a redacted placeholder. So at *that* layer
    we swap to a redacted message and surface the violation in logs
    instead of raising.

    Returns the cleaned narrative when safe, or a redacted placeholder
    that names the offending word so reviewers can spot it. The
    placeholder satisfies ``min_length=1`` Pydantic constraints.
    """
    try:
        return sanitize_narrative(narrative)
    except ForbiddenWordError as exc:
        template = (
            redaction_template
            or "[narrative redacted — sanitizer caught '{word}' at position {pos}]"
        )
        return template.format(word=exc.word, pos=exc.position)
