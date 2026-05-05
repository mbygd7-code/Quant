"""Hard-stop guards for the executor layer (CLAUDE.md section D).

Live trading modes (`kis_real`, `kiwoom_real`) MUST require an explicit
user-acknowledged commit. Until then, importing or instantiating any
real-broker class raises SecurityError. The orchestrator pipeline also
checks this on startup.
"""
from __future__ import annotations

import os

# Modes that the MVP / Phase 2 are allowed to run in.
ALLOWED_MODES: frozenset[str] = frozenset({"report_only", "paper"})

# Modes that require explicit Phase 3 user approval.
LIVE_MODES: frozenset[str] = frozenset({"kis_real", "kiwoom_real"})


class SecurityError(RuntimeError):
    """Raised when a forbidden execution mode is detected."""


def current_mode() -> str:
    return os.environ.get("EXECUTION_MODE", "report_only")


def check_execution_mode() -> str:
    """Validate the env var and return the current mode. Raise on forbidden values."""
    mode = current_mode()
    if mode in ALLOWED_MODES:
        return mode
    if mode in LIVE_MODES:
        raise SecurityError(
            f"EXECUTION_MODE={mode!r} is a LIVE TRADING mode and requires "
            "explicit Phase 3 user approval. Implement KISBroker/KiwoomBroker "
            "in a separate session per CLAUDE.md section D."
        )
    raise SecurityError(
        f"EXECUTION_MODE={mode!r} is not recognized. "
        f"Allowed: {sorted(ALLOWED_MODES)}; live (Phase 3): {sorted(LIVE_MODES)}."
    )
