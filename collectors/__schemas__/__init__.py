"""Pydantic v2 models for raw collector outputs.

Naming convention: collectors return *validated* model instances. Anything
that fails validation is logged and discarded — never silently corrected
(CLAUDE.md §B).
"""
from collectors.__schemas__.global_ import FxQuote, GlobalNews, GlobalQuote
from collectors.__schemas__.korea import KoreaQuote, KoreaSupplyDemand

__all__ = [
    "FxQuote",
    "GlobalNews",
    "GlobalQuote",
    "KoreaQuote",
    "KoreaSupplyDemand",
]
