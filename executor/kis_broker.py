"""KISBroker — Phase 3 stub.

Korea Investment & Securities (KIS) OpenAPI integration is a LIVE TRADING
backend (CLAUDE.md section D). Instantiation deliberately fails until the
operator removes this guard in a separate, user-acknowledged session.

Required to enable later:
  1. KIS API account + appkey/appsecret in `secrets.kr.local` (gitignored)
  2. EXECUTION_MODE=kis_real env (also gated by executor.safety)
  3. Replace this stub with a full implementation honoring rate limits +
     market open/close windows.
"""
from __future__ import annotations

from executor.broker_interface import BrokerInterface


class KISBroker(BrokerInterface):
    def __init__(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "KIS 실거래 연동은 Phase 3입니다. "
            "사용자 명시 승인 후 별도 세션에서 구현하세요. (CLAUDE.md §D)"
        )

    # The abstract methods exist only so subclassing is structurally complete;
    # they're unreachable because __init__ raises.
    def get_balance(self): raise NotImplementedError
    def place_order(self, order): raise NotImplementedError
    def get_positions(self): raise NotImplementedError
    def cancel_order(self, order_id): raise NotImplementedError
