"""Anthropic API wrapper used by all 8 characters.

The legacy ``cognition/sentiment.py`` and ``cognition/scorer.py`` keep
their own Anthropic call sites — Strangler Fig means we don't touch
them. Every new agent code path goes through this module.

Public surface::

    from agents.llm import (
        AgentLLMError,
        CacheBlock,
        ClaudeMessage,
        ClaudeResult,
        call_claude,
        forbidden_words_violations,
        sanitize_narrative,
    )

Design priorities:

  1. **Prompt caching**. Every call accepts a list of cache blocks
     (system prompts, RAG context, few-shot exemplars) that are
     marked ``cache_control: ephemeral``. Cache hit ratio is logged
     in :mod:`agents.observability`.
  2. **Single retry contract**. Anthropic rate limits + transient
     5xx are retried twice with exponential backoff via ``tenacity``.
     Anything else propagates as :class:`AgentLLMError`.
  3. **Structured output guard**. ``call_claude`` accepts an optional
     Pydantic model class; the response text is parsed-and-validated
     before return. Parse failures retry up to 2 more times, then
     raise — same contract as legacy ``cognition.scorer``.
  4. **Forbidden-word post-validation**. CLAUDE.md §3-A bans words
     like '매수' / '매도' / '강력 추천' from any user-facing narrative.
     :func:`sanitize_narrative` raises if a violation slips through.
"""
from agents.llm.client import (
    AgentLLMError,
    CacheBlock,
    ClaudeMessage,
    ClaudeResult,
    call_claude,
)
from agents.llm.sanitize import (
    FORBIDDEN_WORDS,
    ForbiddenWordError,
    forbidden_words_violations,
    sanitize_narrative,
    sanitize_narrative_safe,
)

__all__ = [
    "FORBIDDEN_WORDS",
    "AgentLLMError",
    "CacheBlock",
    "ClaudeMessage",
    "ClaudeResult",
    "ForbiddenWordError",
    "call_claude",
    "forbidden_words_violations",
    "sanitize_narrative",
    "sanitize_narrative_safe",
]
