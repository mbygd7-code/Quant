"""refine_all() — orchestrator-facing dispatcher.

Maps a `CollectorResult` to the appropriate refiner. The pipeline runs:

    krx_result    = KrxCollector().fetch(today)
    refine_all(krx_result, source='krx', on_date=today)
    finn_result   = FinnhubCollector().fetch(today)
    refine_all(finn_result, source='finnhub', on_date=today)
"""
from __future__ import annotations

from datetime import date as Date

from collectors._base import CollectorResult
from refinery._base import RefineryReport
from refinery.global_ import FinnhubRefiner
from refinery.korea import KrxRefiner

_REFINERS = {
    "krx":     KrxRefiner,
    "finnhub": FinnhubRefiner,
}


def refine_all(result: CollectorResult, source: str, on_date: Date) -> RefineryReport:
    if source not in _REFINERS:
        raise ValueError(f"Unknown source {source!r}; expected one of {list(_REFINERS)}")
    refiner = _REFINERS[source]()
    return refiner.refine_and_upsert(result.items, on_date)
