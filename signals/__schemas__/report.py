"""StockReport — LLM-generated narrative around an AIScore.

The structural schema is enforced via Anthropic tool_use. After the call, a
post-validation pass rejects any response containing forbidden words
(CLAUDE.md section 3-A).
"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

# CLAUDE.md section 3-A — words that must NEVER appear in a generated report.
# Adding to this list is a deliberate change requiring user approval.
FORBIDDEN_WORDS: tuple[str, ...] = (
    "매수", "매도", "강력 추천", "오늘 오른다", "확정", "보장", "100%",
)

# Descriptive compounds that contain '매수'/'매도' but are NOT recommendations
# (과매수/순매수/매수세 …). A naive substring check false-positives on them;
# standalone '매수'/'매도' and recommendation phrasings still trip the guard.
# Keep in sync with agents/llm/sanitize.py ALLOWED_COMPOUNDS.
ALLOWED_COMPOUNDS: tuple[str, ...] = (
    "과매수", "과매도", "순매수", "순매도", "매수세", "매도세",
    "매수잔량", "매도잔량", "매수호가", "매도호가",
    "매수주체", "매도주체", "매수우위", "매도우위",
)


def _is_allowed_compound(text: str, word: str, pos: int) -> bool:
    """True when the banned ``word`` at ``pos`` is part of a legitimate
    descriptive compound rather than a standalone trade recommendation."""
    for compound in ALLOWED_COMPOUNDS:
        off = compound.find(word)
        if off < 0:
            continue
        start = pos - off
        if start >= 0 and text[start : start + len(compound)] == compound:
            return True
    return False

DISCLAIMER = "\n\n※ 본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다."


class StockReport(BaseModel):
    """LLM tool_use payload. Ticker / signal / score come from input AIScore
    so the LLM doesn't have to repeat (or risk hallucinating) them."""

    model_config = ConfigDict(extra="forbid")

    positive_factors: list[str] = Field(min_length=3, max_length=3,
        description="Exactly 3 evidence-based positive factors. "
                    "Cite numbers/news from the input. 1-2 sentences each.")
    risk_factors: list[str] = Field(min_length=2, max_length=2,
        description="Exactly 2 risk factors. Separate short-term vs structural. "
                    "1-2 sentences each.")
    comment: str = Field(min_length=20, max_length=300,
        description="2-3 sentence overall comment matching the signal-band tone "
                    "(강한 관심 / 관심 / 관망 / 주의 / 위험).")


class ForbiddenWordError(RuntimeError):
    """Raised when a generated report contains a CLAUDE.md section 3-A word."""


class ReportSkipped(RuntimeError):
    """Raised when retries are exhausted and the report cannot be salvaged."""


def validate_report(report: StockReport) -> None:
    """Check every user-visible string for forbidden words. Raises on violation.

    Descriptive compounds (과매수/순매수/매수세 …) are exempt — only a
    standalone '매수'/'매도' or a recommendation phrasing trips the guard.
    """
    full_text = " ".join([report.comment, *report.positive_factors, *report.risk_factors])
    for word in FORBIDDEN_WORDS:
        idx = 0
        while True:
            found = full_text.find(word, idx)
            if found < 0:
                break
            if not _is_allowed_compound(full_text, word, found):
                raise ForbiddenWordError(f"Forbidden word found: {word!r}")
            idx = found + len(word)


def with_disclaimer(report: StockReport) -> StockReport:
    """Return a copy of the report with the legal disclaimer appended to comment."""
    if report.comment.endswith(DISCLAIMER.strip()):
        return report
    return StockReport(
        positive_factors=report.positive_factors,
        risk_factors=report.risk_factors,
        comment=report.comment + DISCLAIMER,
    )
