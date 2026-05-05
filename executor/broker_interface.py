"""BrokerInterface — abstract base for any execution backend.

PaperBroker is the only concrete implementation in Phase 1. KISBroker and
KiwoomBroker exist as deliberate-failure stubs (CLAUDE.md section D) until
explicit user approval lifts the Phase 3 gate.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from executor.__schemas__.order import Balance, Order, OrderResult, Position


class BrokerInterface(ABC):
    @abstractmethod
    def get_balance(self) -> Balance:
        """Return cash + invested + total_value snapshot."""

    @abstractmethod
    def place_order(self, order: Order) -> OrderResult:
        """Submit an order. Implementations decide fill timing/price."""

    @abstractmethod
    def get_positions(self) -> list[Position]:
        """Return the current portfolio (one row per ticker held)."""

    @abstractmethod
    def cancel_order(self, order_id: str) -> None:
        """Cancel or reverse a previously-placed order."""
