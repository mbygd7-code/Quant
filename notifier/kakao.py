"""KakaoNotifier — Phase 2 stub.

Kakao Biz Message requires:
  1. 사업자 등록 + 카카오 비즈니스 채널 개설
  2. 알림톡 템플릿 사전 승인 (변동성/고지의무 검수)
  3. 솔루션 사업자 (NHN, 알리고, etc.) 계약

Until those are in place, instantiation deliberately fails so a misconfigured
NOTIFY_CHANNELS=kakao env can't silently swallow alerts.
"""
from __future__ import annotations


class KakaoNotifier:
    def __init__(self, *args, **kwargs) -> None:
        raise NotImplementedError(
            "Kakao Biz Message는 Phase 2입니다. "
            "사업자 등록 + 템플릿 승인 후 별도 세션에서 구현하세요. "
            "NOTIFY_CHANNELS 환경변수에서 'kakao'를 제거하세요."
        )
