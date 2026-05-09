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


def test_partial_match_does_not_false_positive() -> None:
    """'매수세' contains '매수' as a substring — and we *do* flag it.
    The CLAUDE.md spec is intentionally conservative; if Soros wants
    to discuss '매수세' he must rephrase. This test pins that
    behaviour so anyone changing the gate to fuzzy/word-boundary
    matching has to update this expectation deliberately."""
    text = "외국인 매수세 강화"
    with pytest.raises(ForbiddenWordError):
        sanitize_narrative(text)


def test_empty_text_passes() -> None:
    assert sanitize_narrative("") == ""
