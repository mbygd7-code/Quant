"""External API collectors. No business logic — only data fetching.

Public surface:
  - BaseCollector, CollectorResult — shared base class + result tuple
  - KrxCollector                    — pykrx-based KR market data
  - FinnhubCollector                — finnhub-python global data + news
"""
from collectors._base import BaseCollector, CollectorResult

__all__ = [
    "BaseCollector",
    "CollectorResult",
    "KrxCollector",
    "FinnhubCollector",
]


def __getattr__(name: str):
    # Lazy import — heavy deps (pykrx, finnhub) only loaded when actually used,
    # so apps/api importing `collectors` doesn't pull them in.
    if name == "KrxCollector":
        from collectors.krx import KrxCollector
        return KrxCollector
    if name == "FinnhubCollector":
        from collectors.finnhub import FinnhubCollector
        return FinnhubCollector
    raise AttributeError(f"module 'collectors' has no attribute {name!r}")
