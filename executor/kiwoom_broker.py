"""KiwoomBroker — Phase 3 stub. Same gating policy as KISBroker."""
from __future__ import annotations

from executor.broker_interface import BrokerInterface


class KiwoomBroker(BrokerInterface):
    def __init__(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "Kiwoom 실거래 연동은 Phase 3입니다. "
            "사용자 명시 승인 후 별도 세션에서 구현하세요. (CLAUDE.md §D)"
        )

    def get_balance(self): raise NotImplementedError
    def place_order(self, order): raise NotImplementedError
    def get_positions(self): raise NotImplementedError
    def cancel_order(self, order_id): raise NotImplementedError
