"""Character implementations.

Each character is a pure-Python class that takes a ticker + cycle
timestamp and returns an :class:`agents.db.models.AgentOutputNew` row.
The cycle orchestrator (``agents/cycle/``) wires them up; characters
themselves do not write to the DB — that responsibility lives in the
orchestrator so a single transaction can roll back cleanly on
failure.

Public surface is deliberately tiny — characters are imported by
their concrete classes::

    from agents.characters import Graham, Dow, InsufficientDataError
"""
from agents.characters._base import Character, InsufficientDataError

__all__ = [
    "Character",
    "InsufficientDataError",
]
