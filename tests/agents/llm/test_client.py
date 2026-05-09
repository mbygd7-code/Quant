"""Tests for ``call_claude`` — mock the Anthropic SDK end to end.

Covers:
  * happy path returns ClaudeResult with text + token usage + cost
  * structured-output path parses with the response_model and returns
    the typed value
  * structured-output parse failure → 1 retry with self-correction
    user turn appended
  * transient error (RateLimit / 5xx) → backoff + retry
  * non-transient error → AgentLLMError immediately
  * cache blocks materialise as the multi-block ``system`` payload
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from pydantic import BaseModel

from agents.llm import (
    AgentLLMError,
    CacheBlock,
    ClaudeMessage,
    call_claude,
)
from agents.llm.client import _build_system_blocks


class _DummySchema(BaseModel):
    score: float
    reason: str


def _fake_response(text: str, *, in_tok: int = 100, out_tok: int = 50) -> Any:
    """Build an object that quacks like an Anthropic Message response."""
    block = MagicMock()
    block.type = "text"
    block.text = text
    usage = MagicMock()
    usage.input_tokens = in_tok
    usage.output_tokens = out_tok
    usage.cache_creation_input_tokens = 0
    usage.cache_read_input_tokens = 0
    response = MagicMock()
    response.content = [block]
    response.usage = usage
    return response


@pytest.fixture
def env_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-fake-key")


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace :func:`agents.llm.client._client` with a stub that
    returns a MagicMock whose ``messages.create`` we control."""
    client = MagicMock()
    client.messages.create = MagicMock()
    monkeypatch.setattr("agents.llm.client._client", lambda: client)
    return client


def test_happy_path_returns_text_and_usage(
    env_key: None, fake_client: MagicMock
) -> None:
    fake_client.messages.create.return_value = _fake_response(
        "단순 응답", in_tok=200, out_tok=80
    )

    result, parsed = call_claude(
        messages=[ClaudeMessage(role="user", content="안녕")],
        system="너는 Soros다.",
    )

    assert result.text == "단순 응답"
    assert result.input_tokens == 200
    assert result.output_tokens == 80
    assert result.cost_estimate_usd > 0
    assert parsed is None
    fake_client.messages.create.assert_called_once()


def test_structured_output_parses(env_key: None, fake_client: MagicMock) -> None:
    fake_client.messages.create.return_value = _fake_response(
        '{"score": 0.42, "reason": "관심 신호"}'
    )

    result, parsed = call_claude(
        messages=[ClaudeMessage(role="user", content="?")],
        response_model=_DummySchema,
    )

    assert isinstance(parsed, _DummySchema)
    assert parsed.score == 0.42
    assert parsed.reason == "관심 신호"
    assert result.text.startswith('{"score":')


def test_structured_output_retries_with_correction(
    env_key: None, fake_client: MagicMock
) -> None:
    """First call returns junk → second call returns valid JSON."""
    fake_client.messages.create.side_effect = [
        _fake_response("not JSON at all"),
        _fake_response('{"score": 1.0, "reason": "ok"}'),
    ]

    _, parsed = call_claude(
        messages=[ClaudeMessage(role="user", content="?")],
        response_model=_DummySchema,
        max_attempts=2,
    )

    assert parsed is not None
    assert parsed.score == 1.0
    # The second call must include the self-correction user message.
    second_call_kwargs = fake_client.messages.create.call_args_list[1].kwargs
    last_msg = second_call_kwargs["messages"][-1]
    assert last_msg["role"] == "user"
    assert "JSON" in last_msg["content"]


def test_transient_error_retries_then_succeeds(
    env_key: None, fake_client: MagicMock
) -> None:
    """A 5xx on the first attempt should backoff + retry, not raise."""
    transient = _make_status_error(503)
    fake_client.messages.create.side_effect = [
        transient,
        _fake_response("드디어 응답"),
    ]

    with patch("agents.llm.client.time.sleep"):  # skip backoff sleep
        result, _ = call_claude(
            messages=[ClaudeMessage(role="user", content="?")],
            max_attempts=2,
        )

    assert result.text == "드디어 응답"
    assert fake_client.messages.create.call_count == 2


def test_transient_error_exhausts_attempts(
    env_key: None, fake_client: MagicMock
) -> None:
    transient = _make_status_error(503)
    fake_client.messages.create.side_effect = [transient, transient]

    with patch("agents.llm.client.time.sleep"), pytest.raises(AgentLLMError):
        call_claude(
            messages=[ClaudeMessage(role="user", content="?")],
            max_attempts=2,
        )


def test_non_transient_error_propagates(
    env_key: None, fake_client: MagicMock
) -> None:
    """A 400 (bad request) should NOT retry — wrong inputs won't fix
    themselves."""
    bad = _make_status_error(400)
    fake_client.messages.create.side_effect = [bad]

    with pytest.raises(AgentLLMError):
        call_claude(
            messages=[ClaudeMessage(role="user", content="?")],
            max_attempts=3,
        )

    # Only one call — no retry on non-transient.
    assert fake_client.messages.create.call_count == 1


def test_missing_api_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(AgentLLMError, match="ANTHROPIC_API_KEY"):
        call_claude(
            messages=[ClaudeMessage(role="user", content="?")],
        )


def test_cache_blocks_emit_multi_block_system() -> None:
    """When cache blocks are present, the system field should be a
    list of typed blocks, not a plain string."""
    blocks = _build_system_blocks(
        "system prompt",
        [CacheBlock(text="huge RAG context", label="rag")],
    )
    assert isinstance(blocks, list)
    assert blocks[0]["type"] == "text"
    assert blocks[0]["text"] == "system prompt"
    assert "cache_control" not in blocks[0]
    assert blocks[1]["text"] == "huge RAG context"
    assert blocks[1]["cache_control"] == {"type": "ephemeral"}


def test_no_cache_no_system_returns_none() -> None:
    assert _build_system_blocks(None, None) is None


def test_only_system_returns_plain_string() -> None:
    """No caching needed → save the cycles by sending a string, not a
    one-element list."""
    out = _build_system_blocks("just system", None)
    assert out == "just system"


# ─── helpers ─────────────────────────────────────────────────────────


def _make_status_error(status: int) -> Exception:
    """Build something the client treats as a transient APIStatusError.

    We can't ``import anthropic`` and instantiate the real class
    because the test environment may not have it; we monkey-patch the
    transient detector to recognise our marker class instead."""
    err = _FakeStatusError(f"status {status}")
    err.status_code = status
    return err


class _FakeStatusError(Exception):
    status_code: int = 500


# Patch the transient detector once for the test module so the fake
# error is recognised as transient.
import agents.llm.client as _client_module  # noqa: E402

_orig_is_transient = _client_module._is_transient


def _is_transient_with_fake(exc: BaseException) -> bool:
    if isinstance(exc, _FakeStatusError):
        return getattr(exc, "status_code", 0) >= 500
    return _orig_is_transient(exc)


_client_module._is_transient = _is_transient_with_fake


# ─── _strip_json_fences ─────────────────────────────────────────────


import pytest as _pytest

from agents.llm.client import _strip_json_fences as _strip


@_pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('{"x": 1}', '{"x": 1}'),
        ('```json\n{"x": 1}\n```', '{"x": 1}'),
        ('```\n{"x": 1}\n```', '{"x": 1}'),
        ('  ```json\n{"x": 1}\n```  ', '{"x": 1}'),
        ('```json{"x": 1}```', '{"x": 1}'),
        ('```JSON\n{"x": 1}\n```', '{"x": 1}'),
    ],
)
def test_strip_json_fences_handles_common_wraps(
    raw: str, expected: str
) -> None:
    """Pin the markdown-fence stripper Pydantic depends on. Real
    Anthropic responses occasionally wrap JSON in ```` ```json ```` despite
    the JSON-only system prompt; we must recover before model_validate_json."""
    assert _strip(raw) == expected
