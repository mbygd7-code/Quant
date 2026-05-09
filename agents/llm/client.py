"""Anthropic API wrapper with prompt caching, retries, and structured-output guard.

Used by every 8-character analysis cron. The legacy ``cognition/`` and
``signals/`` paths keep their own Anthropic calls to avoid touching
production code mid-refactor.

Reads ``ANTHROPIC_API_KEY`` from the environment, same convention as
the legacy code paths.
"""
from __future__ import annotations

import os
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

# Defer import so test environments that don't have anthropic installed
# can still import the package for type hints.
try:
    import anthropic  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover - exercised only on slim runtimes
    anthropic = None  # type: ignore[assignment]

#: Model id matching CLAUDE.md §5. Override with ANTHROPIC_MODEL=...
DEFAULT_MODEL = "claude-sonnet-4-6"

#: 4k input / 1k output budget per CLAUDE.md §8.
DEFAULT_MAX_TOKENS = 1024
DEFAULT_INPUT_BUDGET = 4096

T = TypeVar("T", bound=BaseModel)


class AgentLLMError(RuntimeError):
    """Failure that survived all retries (rate limit, parse, sanitize)."""


@dataclass
class CacheBlock:
    """A piece of context to send with ``cache_control: ephemeral``.

    Anthropic recommends placing stable bulk text (system prompt, RAG
    snippets, few-shot examples) in cached blocks; only the volatile
    user turn is paid in full.
    """

    text: str
    """The text payload."""

    label: str | None = None
    """Optional human-friendly label written to telemetry. Has no
    effect on the API call itself."""


@dataclass
class ClaudeMessage:
    """A single user/assistant turn in the conversation."""

    role: str  # "user" | "assistant"
    content: str


@dataclass
class ClaudeResult:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cost_estimate_usd: float = 0.0
    latency_ms: int = 0
    raw: Any = field(default=None, repr=False)


# Pricing (USD per million tokens) — matches Anthropic public pricing
# 2024-Q4 for the Sonnet tier. Cache reads are 90% off.
_PRICE_INPUT = 3.0 / 1_000_000
_PRICE_OUTPUT = 15.0 / 1_000_000
_PRICE_CACHE_WRITE = 3.75 / 1_000_000
_PRICE_CACHE_READ = 0.30 / 1_000_000


def _estimate_cost(usage: Any, model: str) -> float:
    """Heuristic — pricing differs by tier; the 8-character system
    runs on Sonnet exclusively per CLAUDE.md §5. If a future call
    uses Opus we'll re-rate; for now Sonnet figures suffice."""
    return (
        getattr(usage, "input_tokens", 0) * _PRICE_INPUT
        + getattr(usage, "output_tokens", 0) * _PRICE_OUTPUT
        + getattr(usage, "cache_creation_input_tokens", 0) * _PRICE_CACHE_WRITE
        + getattr(usage, "cache_read_input_tokens", 0) * _PRICE_CACHE_READ
    )


def _build_system_blocks(
    system: str | None, cache: Iterable[CacheBlock] | None
) -> list[dict[str, Any]] | str | None:
    """Anthropic's system field accepts either a string or a list of
    text blocks (each can be cached individually). Use the list form
    when cache blocks are present."""
    blocks: list[dict[str, Any]] = []
    if system:
        blocks.append({"type": "text", "text": system})
    for cb in cache or ():
        blocks.append(
            {
                "type": "text",
                "text": cb.text,
                "cache_control": {"type": "ephemeral"},
            }
        )
    if not blocks:
        return None
    if len(blocks) == 1 and "cache_control" not in blocks[0]:
        return blocks[0]["text"]  # plain string when no caching
    return blocks


def _client() -> Any:
    if anthropic is None:
        raise AgentLLMError("anthropic SDK not installed in this runtime")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise AgentLLMError("ANTHROPIC_API_KEY is not set")
    return anthropic.Anthropic(api_key=api_key)


def _sleep_with_backoff(attempt: int) -> None:
    # 0.5s, 1.5s, 4.5s — three steps cap.
    delay = 0.5 * (3 ** attempt)
    time.sleep(min(delay, 8.0))


def call_claude(
    *,
    messages: list[ClaudeMessage],
    system: str | None = None,
    cache: Iterable[CacheBlock] | None = None,
    response_model: type[T] | None = None,
    model: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    temperature: float = 0.4,
    max_attempts: int = 3,
) -> tuple[ClaudeResult, T | None]:
    """Single Anthropic call with caching + retries + optional
    Pydantic-parsed return.

    Returns ``(result, parsed)`` where ``parsed`` is the
    ``response_model`` instance when one was requested and parsing
    succeeded, else ``None``.

    Retries
    -------
    * Anthropic ``RateLimitError`` and ``APIStatusError`` 5xx → up to
      ``max_attempts`` total tries with exponential backoff.
    * ``response_model`` parse failure → counted as one attempt; the
      raw text is fed back to the next try as an assistant turn so the
      model can self-correct (matches the legacy scorer's pattern).
    * Anything else → :class:`AgentLLMError` immediately.
    """
    client = _client()
    chosen_model = model or os.environ.get("ANTHROPIC_MODEL", DEFAULT_MODEL)
    sys_blocks = _build_system_blocks(system, cache)

    last_error: Exception | None = None
    parse_correction: ClaudeMessage | None = None

    for attempt in range(max_attempts):
        msg_payload = [{"role": m.role, "content": m.content} for m in messages]
        if parse_correction is not None:
            msg_payload.append(
                {"role": parse_correction.role, "content": parse_correction.content}
            )

        try:
            t0 = time.monotonic()
            kwargs: dict[str, Any] = {
                "model": chosen_model,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "messages": msg_payload,
            }
            if sys_blocks is not None:
                kwargs["system"] = sys_blocks
            response = client.messages.create(**kwargs)
            latency_ms = int((time.monotonic() - t0) * 1000)
        except Exception as exc:  # broad on purpose; we re-raise typed
            last_error = exc
            transient = _is_transient(exc)
            if not transient or attempt == max_attempts - 1:
                raise AgentLLMError(
                    f"Anthropic call failed (attempt {attempt + 1}): {exc}"
                ) from exc
            _sleep_with_backoff(attempt)
            continue

        text = _extract_text(response)
        usage = getattr(response, "usage", None)
        result = ClaudeResult(
            text=text,
            model=chosen_model,
            input_tokens=getattr(usage, "input_tokens", 0),
            output_tokens=getattr(usage, "output_tokens", 0),
            cache_creation_input_tokens=getattr(
                usage, "cache_creation_input_tokens", 0
            ),
            cache_read_input_tokens=getattr(usage, "cache_read_input_tokens", 0),
            cost_estimate_usd=_estimate_cost(usage, chosen_model) if usage else 0.0,
            latency_ms=latency_ms,
            raw=response,
        )

        if response_model is None:
            return result, None

        try:
            parsed = response_model.model_validate_json(text)
            return result, parsed
        except ValidationError as exc:
            last_error = exc
            if attempt == max_attempts - 1:
                raise AgentLLMError(
                    f"response did not parse as {response_model.__name__} "
                    f"after {max_attempts} attempts: {exc}"
                ) from exc
            parse_correction = ClaudeMessage(
                role="user",
                content=(
                    "직전 응답을 지정된 JSON 스키마로 파싱하지 못했습니다. "
                    "스키마 이외의 키나 텍스트 없이 JSON만 다시 응답해 주세요. "
                    f"오류: {exc}"
                ),
            )
            continue

    # Unreachable in practice — kept for type-checker happiness.
    raise AgentLLMError(f"call_claude exhausted attempts; last error: {last_error}")


def _extract_text(response: Any) -> str:
    """Anthropic returns ``content`` as a list of blocks; the first
    block in a non-tool response is the assistant text."""
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        block_type = getattr(block, "type", None)
        if block_type == "text":
            parts.append(getattr(block, "text", ""))
    return "".join(parts)


def _is_transient(exc: BaseException) -> bool:
    if anthropic is None:
        return False
    if isinstance(exc, getattr(anthropic, "RateLimitError", ())):
        return True
    if isinstance(exc, getattr(anthropic, "APIStatusError", ())):
        status = getattr(exc, "status_code", 0)
        return status >= 500
    return bool(isinstance(exc, getattr(anthropic, "APIConnectionError", ())))
