"""Convert a Pydantic model to an Anthropic `tool` JSON schema.

Anthropic's `messages.create(tools=[...], tool_choice={'type': 'tool', 'name': ...})`
forces the model to emit structured JSON matching our Pydantic schema. This is
strictly more reliable than asking for JSON in free-text and parsing.
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel

__all__ = ["pydantic_to_tool", "extract_tool_input"]


def pydantic_to_tool(model: type[BaseModel], *, name: str, description: str) -> dict[str, Any]:
    """Build the Anthropic tool definition dict from a Pydantic model class."""
    schema = model.model_json_schema()
    # Anthropic doesn't accept `$defs` at the top level the same way OpenAI does;
    # inline simple Literal/Enum refs by leaving the JSON schema as-is — Anthropic
    # accepts standard JSON Schema 2020-12 with $defs.
    return {
        "name": name,
        "description": description,
        "input_schema": {
            "type": "object",
            "properties": schema.get("properties", {}),
            "required": schema.get("required", []),
            "$defs": schema.get("$defs", {}),
        },
    }


def extract_tool_input(message: Any, tool_name: str) -> dict[str, Any]:
    """Pull the tool_use input dict out of an Anthropic Message response.

    `message` is an `anthropic.types.Message`. Raises ValueError if the model
    didn't call the tool (which forced tool_choice should prevent).
    """
    for block in message.content:
        # block.type == 'tool_use' for forced tool calls
        if getattr(block, "type", None) == "tool_use" and block.name == tool_name:
            return block.input
    raise ValueError(
        f"Expected tool_use block for {tool_name!r}, got: "
        f"{[getattr(b, 'type', '?') for b in message.content]}"
    )
