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
from agents.characters.dow import Dow
from agents.characters.graham import Graham
from agents.characters.keynes import Keynes
from agents.characters.shiller import Shiller
from agents.characters.soros import Soros
from agents.characters.taleb import Taleb

__all__ = [
    "Character",
    "InsufficientDataError",
    "Dow",
    "Graham",
    "Keynes",
    "Shiller",
    "Soros",
    "Taleb",
]
