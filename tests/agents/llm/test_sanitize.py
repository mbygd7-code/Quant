"""Tests for the forbidden-word gate."""
from __future__ import annotations

import pytest

from agents.llm import (
    FORBIDDEN_WORDS,
    ForbiddenWordError,
    forbidden_words_violations,
    sanitize_narrative,
)


def test_clean_text_passes() -> None:
    text = "삼성전자는 반도체 업황 회복 신호와 함께 관심 있게 지켜볼 종목입니다."
    assert sanitize_narrative(text) == text


def test_each_forbidden_word_caught() -> None:
    """Every banned word should trigger an error in isolation."""
    for word in FORBIDDEN_WORDS:
        text = f"이번 주는 {word}를 권합니다."
        with pytest.raises(ForbiddenWordError) as exc:
            sanitize_narrative(text)
        assert exc.value.word == word


def test_first_violation_returned_first() -> None:
    text = "보장된 100% 수익"
    with pytest.raises(ForbiddenWordError) as exc:
        sanitize_narrative(text)
    assert exc.value.word == "보장"


def test_violations_lister_returns_all() -> None:
    text = "매수 매도 후 다시 매수"
    violations = forbidden_words_violations(text)
    words = [w for w, _ in violations]
    assert words.count("매수") == 2
    assert words.count("매도") == 1


def test_descriptive_compounds_are_exempt() -> None:
    """Legitimate market/technical compounds that merely CONTAIN '매수'/'매도'
    as a substring are descriptive, not recommendations, and must pass.

    The guard used to flag these — which redacted ~70% of Turing's RSI
    narratives ('과매수 영역' → caught on the inner '매수'). The exemption
    list (ALLOWED_COMPOUNDS) fixes that false-positive while keeping the
    recommendation ban intact (see test below)."""
    for text in (
        "RSI가 과매수 영역에 진입했습니다",
        "기술적 과매도 구간입니다",
        "외국인 순매수가 유입되고 있습니다",
        "기관 순매도 전환",
        "외국인 매수세 강화",
        "매도세가 우위입니다",
        "매수호가 잔량이 매도잔량을 상회",
        "매수주체가 기관으로 이동",
    ):
        assert sanitize_narrative(text) == text


def test_recommendation_phrasings_still_blocked() -> None:
    """The exemption must NOT leak standalone '매수'/'매도' or any trade
    recommendation — those still trip the guard."""
    for text in (
        "지금 매수하세요",
        "매수 추천 신호입니다",
        "지금이 매수 적기입니다",
        "매도 타이밍입니다",
        "이번 주는 매수를 권합니다",
    ):
        with pytest.raises(ForbiddenWordError):
            sanitize_narrative(text)


def test_empty_text_passes() -> None:
    assert sanitize_narrative("") == ""


# ─── sanitize_narrative_safe ─────────────────────────────────────────


from agents.llm.sanitize import sanitize_narrative_safe  # noqa: E402


def test_safe_passes_clean_narrative_unchanged() -> None:
    text = "안전마진이 충분히 확보된 수준입니다."
    assert sanitize_narrative_safe(text) == text


def test_safe_redacts_instead_of_raising_on_forbidden_word() -> None:
    """Soros aggregates 5 voters; a single banned word should NOT
    discard every voter's contribution. The safe variant returns a
    redacted placeholder so the synthesis row still gets written."""
    text = "이 종목의 추세가 확정적으로 상승입니다."
    out = sanitize_narrative_safe(text)
    # The placeholder names the offending word so reviewers can spot it.
    assert "redacted" in out
    assert "확정" in out
    # Still satisfies min_length=10 Pydantic constraint.
    assert len(out) >= 10


def test_safe_custom_redaction_template() -> None:
    text = "보장된 수익이 예상됩니다."
    out = sanitize_narrative_safe(
        text, redaction_template="[blocked: {word}]"
    )
    assert out == "[blocked: 보장]"
