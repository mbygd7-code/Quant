"""Trade execution interface (PaperBroker only in MVP).

Public surface:
  - BrokerInterface, Order, Position, Balance, OrderResult
  - PaperBroker                             — Phase 1/2 paper trading
  - KISBroker, KiwoomBroker                 — Phase 3 stubs (raise on init)
  - SecurityError, check_execution_mode()   — CLAUDE.md §D guards
"""
from executor.__schemas__.order import Balance, Order, OrderResult, Position
from executor.broker_interface import BrokerInterface
from executor.kis_broker import KISBroker
from executor.kiwoom_broker import KiwoomBroker
from executor.paper_broker import INITIAL_CAPITAL_KRW, PaperBroker
from executor.safety import (
    ALLOWED_MODES,
    LIVE_MODES,
    SecurityError,
    check_execution_mode,
    current_mode,
)

__all__ = [
    "BrokerInterface", "Order", "Position", "Balance", "OrderResult",
    "PaperBroker", "INITIAL_CAPITAL_KRW",
    "KISBroker", "KiwoomBroker",
    "SecurityError", "check_execution_mode", "current_mode",
    "ALLOWED_MODES", "LIVE_MODES",
]
