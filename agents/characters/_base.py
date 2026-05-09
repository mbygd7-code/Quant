"""Base contract for the 8 character implementations.

A ``Character`` consumes pre-fetched data + the LLM wrapper and
returns an :class:`AgentOutputNew` ready for the repository to write.
We deliberately keep IO out of the analyze method so unit tests can
run without a Supabase round-trip — the cycle orchestrator does the
fetch + write, characters do the synthesis.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import ClassVar

from agents.db.models import AgentName, AgentOutputNew


class InsufficientDataError(RuntimeError):
    """Raised when a character cannot produce a meaningful score from
    the data window it was given. Cycle orchestrators should treat this
    as a *skip* rather than a *failure* — the ticker has insufficient
    history (e.g., recent IPO, ingestion not yet caught up) and will
    re-evaluate on the next cycle.
    """

    def __init__(self, character: str, ticker: str, reason: str) -> None:
        self.character = character
        self.ticker = ticker
        self.reason = reason
        super().__init__(f"{character}: {ticker}: {reason}")


class Character(ABC):
    """Common contract for the 8 character implementations.

    Sub-classes set :attr:`agent_name` (matches the agent_name CHECK
    in migration 18) and implement :meth:`analyze`. The orchestrator
    calls :meth:`analyze` for each ticker in the watchlist, then
    persists the returned ``AgentOutputNew`` via the repository.

    Concrete characters land in M2-T2 (Graham), M2-T3 (Dow), M2-T4
    (Soros — separate ``synthesize`` flow because it consumes other
    characters' outputs rather than raw market data).
    """

    agent_name: ClassVar[AgentName]
    """Slug identifying the character — must be one of the 8 names
    accepted by the agent_outputs CHECK constraint."""

    @abstractmethod
    def analyze(self, ticker: str, cycle_at: datetime) -> AgentOutputNew:
        """Run the character's analysis and return a row ready for
        :meth:`agents.db.repository.AgentRepository.insert_agent_output`.

        Implementations should:
          * raise :class:`InsufficientDataError` rather than fabricate
            scores when input data is too thin
          * route LLM calls through :func:`agents.llm.call_claude`
            so prompt caching + retries are uniform
          * write Korean narratives that pass
            :func:`agents.llm.sanitize_narrative`
        """
        raise NotImplementedError
