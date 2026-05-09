# 📚 QuantSignal 시스템 설계 마스터 인덱스

> **버전**: v1.0 (설계 완료, 구현 전)
> **최종 갱신**: 2025-01-15
> **총 문서 수**: 14개 (시스템 7개 + 캐릭터 8개 + 본 인덱스 1개)

---

## 0. 이 문서를 처음 보시는 분께

### 무엇을 만들고 있나요?

QuantSignal은 **8명의 AI 분석가가 협력해서 베이영님의 투자 의사결정을 돕는** 시스템입니다.

- 단타 트레이딩 봇이 아닙니다
- 장기 투자자를 위한 **의사결정 보조 도구**입니다
- 메인 인터페이스는 **차트 + 워치리스트 + 알림** (관제실)
- AI 캐릭터들과의 대화는 *보조 기능*

### 8명의 AI 분석가는 누구인가요?

```
🎯 Soros    - 데스크 헤드 (최종 결정자, 사용자의 유일한 대화 상대)
🦅 Taleb    - 리스크 와처 (모든 결정에 반박)
📊 Simons   - 퀀트 애널리스트 (ML·정량 분석, PC 워커 활용)
💎 Graham   - 가치 분석가 (본질가치·안전마진)
📈 Dow      - 기술적 분석가 (차트·추세)
💭 Shiller  - 시장 사이클 분석가 (거품·심리)
🌍 Keynes   - 매크로 분석가 (정책·섹터 영향)
🔀 Turing   - 라우터 (백그라운드, 보이지 않음)
```

### 베이영님이 가장 중요하게 여기신 3가지

1. **시스템이 시간이 지나며 강화** — 데이터로 똑똑해지는 구조
2. **캐릭터들이 서로 견제** — 수준 높은 판단을 위한 토론
3. **신뢰를 가지고 거래** — 모든 결정을 추적·검증 가능

---

## 1. 문서 읽기 순서

### 📖 처음 읽으시는 분 (1시간 코스)

```
1. 본 문서 (마스터 인덱스) - 5분
   └─ 전체 그림 파악

2. system-implementation-roadmap.md - 15분
   └─ 무엇을 어떤 순서로 만들지

3. character-soros.md - 15분
   └─ 가장 중요한 캐릭터 (사용자 대표)

4. system-character-relationships.md - 15분
   └─ 캐릭터들이 어떻게 협력·견제하는지

5. system-call-flow.md - 10분
   └─ 사용자 경험 흐름
```

### 📚 깊이 이해하시려는 분 (3-4시간 코스)

```
Phase 1: 기초 (1시간)
  1. 본 문서
  2. system-implementation-roadmap.md
  3. system-character-relationships.md
  4. system-data-flow.md

Phase 2: 캐릭터 (1.5시간)
  5. character-soros.md (대표자)
  6. character-taleb.md (검증자, Soros의 견제축)
  7. character-simons.md (가장 복잡한 캐릭터)
  8. character-graham.md → character-dow.md (가장 빈번한 견제축)
  9. character-shiller.md → character-keynes.md (시장 관점)
  10. character-turing.md (백그라운드 라우터)

Phase 3: 시스템 (1시간)
  11. system-call-flow.md
  12. system-weight-settings.md (가중치 시스템)
  13. system-data-flow.md (다시 보기, 캐릭터 정의 후)
```

### 🛠️ 구현하시려는 분 (참조용)

각 마일스톤별로 필요한 문서:

```
M1 (인프라):
  - system-data-flow.md (DB 스키마)
  - system-weight-settings.md (가중치 API)

M2 (Soros + Graham + Dow):
  - character-soros.md
  - character-graham.md
  - character-dow.md
  - system-character-relationships.md (Graham↔Dow 견제)

M3 (Shiller + Keynes):
  - character-shiller.md
  - character-keynes.md

M4 (Taleb):
  - character-taleb.md
  - 다른 캐릭터들의 "Taleb과의 관계" 섹션

M5 (Simons + PC):
  - character-simons.md
  - system-data-flow.md (PC 워커 부분)

M6-M7 (UI):
  - system-call-flow.md
  - character-turing.md

M8 (강화 학습):
  - 각 캐릭터의 "성장 메커니즘" 섹션
  - system-character-relationships.md (견제축 가치 분석)
```

---

## 2. 전체 문서 카탈로그

### ⚙️ 시스템 정의서 (5개)

| 문서 | 분량 | 핵심 내용 |
|---|---|---|
| `system-implementation-roadmap.md` | 22KB | M1→M9 마일스톤 단계 |
| `system-character-relationships.md` | 19KB | 8명 캐릭터 견제·협력 매트릭스 |
| `system-data-flow.md` | 21KB | 데이터 흐름 다이어그램 (Mermaid) |
| `system-call-flow.md` | 22KB | 사용자 대화 시나리오 |
| `system-weight-settings.md` | 15KB | 가중치 설정 시스템 |

### 🎭 캐릭터 정의서 (8개)

| 캐릭터 | 문서 | 도메인 | 가중치 |
|---|---|---|---:|
| 🎯 Soros | `character-soros.md` | 최종 결정 | — |
| 🦅 Taleb | `character-taleb.md` | 리스크 검증 | 0.13 |
| 📊 Simons | `character-simons.md` | 정량·ML | 0.20 |
| 💎 Graham | `character-graham.md` | 가치·펀더멘털 | 0.18 |
| 📈 Dow | `character-dow.md` | 기술적·추세 | 0.18 |
| 💭 Shiller | `character-shiller.md` | 시장 사이클 | 0.13 |
| 🌍 Keynes | `character-keynes.md` | 매크로 | 0.18 |
| 🔀 Turing | `character-turing.md` | 라우팅 (백그라운드) | — |

### 📋 참고 문서 (1개)

| 문서 | 분량 | 비고 |
|---|---|---|
| `quant-signal-refactor-plan.md` | 13KB | 초기 5각 편대 분석 (참고용, 현재 8명 시스템과 다름) |

---

## 3. 핵심 개념 빠른 참조

### 🎯 8명 캐릭터의 한 줄 정의

| 캐릭터 | 한 줄 정의 |
|---|---|
| **Soros** | 6명 의견 + Taleb 검증을 종합해 최종 시그널 결정 |
| **Taleb** | 모든 결정에 반박, severity 4-5는 자동 시그널 하향 |
| **Simons** | 사이킷런 GBM으로 종목 예측 (PC 워커 활용) |
| **Graham** | 본질가치 계산하여 안전마진 평가 |
| **Dow** | 3-축 시간(주/중/단기)으로 추세 진단 |
| **Shiller** | 시장 사이클(가치/심리/내러티브) 진단, 거품 경고 |
| **Keynes** | 매크로 변수의 섹터별 민감도 평가 |
| **Turing** | 사용자 메시지 → 적절한 캐릭터 라우팅 (백그라운드) |

### 🕸️ 4대 견제축

```
Graham ↔ Dow       (가치 vs 추세) - 가장 빈번
Simons ↔ Shiller   (효율 vs 비합리) - 가장 학술적
Soros ↔ Taleb      (결정 vs 검증) - 매번 발동, 자동 제약
Simons ↔ Taleb     (모델 vs 의심) - 자동 정확도 검증
```

### 🎭 사용자가 만나는 캐릭터

**오직 Soros 한 명**. 다른 7명은 백그라운드에서 일하고, 사용자에게는 *Soros가 모든 것을 정리해서 전달*.

### 📊 가중치 시스템

```
Markowitz 0.20 → Simons 0.20  (정량)
Graham    0.18                (가치)
Dow       0.18                (추세)
Shiller   0.13                (심리)
Keynes    0.18                (매크로)
Taleb     0.13                (리스크, 최소 10% 강제)
─────────────
합계      1.00

사용자가 5%~40% 범위에서 조정 가능
Soros가 시장 상황에 따라 ±50% 임시 조정 가능
```

### 🗺️ 마일스톤 한 줄 요약

```
M1: 인프라 (DB, 가중치 시스템)
M2: Soros + Graham + Dow ← 첫 작동
M3: + Shiller + Keynes
M4: + Taleb (안전장치 활성화)
M5: + Simons + PC 워커 ⚠️ 가장 위험
M6: UI 기본 + 대화
M7: 차트 관제실 ← 베이영님의 핵심 욕망
M8: 강화 학습 활성화 ← 진짜 가치
M9: 사전 학습 데이터 (선택적)
```

---

## 4. 자주 묻는 질문

### Q1. 왜 5각 편대가 아닌 8명인가요?

A. 처음에 받으신 5각 편대 제안(스카우터·애널리스트·리스크매니저·트레이더·프레젠터)은 *현재 7단계 백엔드 파이프라인을 보지 않고 그린 일반론*이었습니다. 베이영님 시스템은 이미 그 단계를 넘어섰고, 장기 투자 의사결정 보조라는 도메인에 8명이 더 적합합니다. 자세한 내용은 `system-implementation-roadmap.md` 참조.

### Q2. 왜 Markowitz가 아닌 Simons인가요?

A. Markowitz는 *포트폴리오 이론가*이고, Simons는 *ML 정량 헤지펀드(Renaissance)의 창시자*입니다. 사이킷런 GBM 기반 종목 예측에는 Simons가 더 정확한 매칭입니다. 베이영님이 9명 → 8명으로 단순화하면서 Simons가 정량 분야 전체를 담당하게 됐습니다.

### Q3. 왜 Turing은 사용자에게 보이지 않나요?

A. *Soros가 사용자의 유일한 대화 상대*라는 결정 때문입니다. 사용자에게 8명을 모두 노출하면 인지 부하가 큽니다. 대신 *내 비서 Soros* 한 명과만 대화하고, 다른 캐릭터들은 *Soros를 통해 의견 전달*. Turing은 시스템 내부 라우터로만 작동.

### Q4. 가장 위험한 마일스톤은?

A. **M5 (Simons + PC 워커)**입니다. PC가 24/7 작동을 보장하지 않아 그레이스풀 디그라데이션이 필수입니다. 다른 5명이 *완벽하게* 작동한 후에만 진행하시길 권장합니다.

### Q5. 시간은 얼마나 걸리나요?

A. 시간 단위 없이 **마일스톤 기반**입니다. 각 마일스톤을 완성도 있게 끝낸 후 다음으로. 베이영님 본업(KinderBoard, MeetFlow)과 병행하시도록 시간 압박을 두지 않았습니다.

### Q6. 강화 효과는 언제부터?

A. **6개월 누적 운영 후 (M8)**부터 의미 있는 강화 효과가 나타납니다. 그 전까지는 *작동하는 시스템*, M8부터는 *성장하는 시스템*. 단, 사전 학습 데이터(M9)를 활용하면 1일차부터 개인화 가능합니다.

### Q7. 비용은 얼마나?

A. 정확한 추정은 어렵지만:
- LLM API: 매일 3회 × 8명 × 평균 0.5분 = 약 월 10-30만원
- Supabase: Pro 플랜 약 $25/월
- 외부 API (Finnhub 등): 약 $50-100/월
- PC 전기료: 월 1-2만원

총 월 30-50만원 수준 예상. 사용자 늘면 비례 증가.

### Q8. 다른 사람도 쓸 수 있나요?

A. 설계상 가능합니다. 단:
- M1-M7 완성 후 베이영님 본인이 1-2개월 사용해 검증 권장
- M9에서 사전 학습 데이터 통합 시 신규 사용자 콜드 스타트 해결
- 유료/무료 모델 결정 필요

---

## 5. 미해결 항목 (전체)

각 문서의 미해결 항목을 한곳에 모음. 본격 구현 시 결정 필요.

### 인프라
- [ ] M0(백테스트 환경) 추가 여부
- [ ] Supabase Realtime 구독 범위
- [ ] 데이터 보존 정책 자동화

### 캐릭터
- [ ] Graham: 할인율 결정 메커니즘 (한국 국채 10년물?)
- [ ] Simons: GBM 하이퍼파라미터 자동 튜닝 (Optuna vs GridSearch)
- [ ] Shiller: PE10 한국 시장 데이터 부족 (30년치 없음)
- [ ] Keynes: 미중 관계 지수 (자체 산출 vs 외부)
- [ ] Taleb: 거짓 경고 임계값

### 시스템
- [ ] 사용자 risk_profile 별도 설정?
- [ ] 음성 입력 지원
- [ ] 다국어 응답
- [ ] 견제축 강도 임계값 (1.5점 차이가 적정?)

### 강화
- [ ] 시장 국면 변화 자동 감지 정확도
- [ ] 사용자별 개인화 학습 주기

---

## 6. 다음 단계 — 베이영님께

설계는 완료됐습니다. 다음 두 가지 중 선택:

### 옵션 A: 즉시 M1 구현 시작
- Supabase 신규 테이블 생성부터
- 베이영님 본인이 직접 또는 Claude Code 활용
- 1-2주 내 인프라 완성 가능

### 옵션 B: 추가 검토·다듬기
- 14개 문서를 다시 읽으며 부족한 부분 발견
- 미해결 항목 중 결정 가능한 것들 합의
- 본격 구현 전 *완벽한 설계* 추구

### 옵션 C: 일부 문서 수정·확장
- 특정 캐릭터의 정의서 더 깊이 작성
- UI 설계서 별도 작성
- API 명세서 작성

---

## 7. 변경 이력

### v1.0 (2025-01-15)
- 8명 캐릭터 정의 완료
- 4개 시스템 통합 문서 완료
- Turing 정의서 v1.1로 업데이트 (백그라운드 라우터 패턴)
- 본 마스터 인덱스 작성

---

## 8. 감사의 말

이 시스템 설계는 베이영님의 다음 통찰에서 시작됐습니다:

> *"이 캐릭터들을 강화시키고 싶거든. 그래야 정확한 예측과 판단을 신뢰를 가지고 거래할 수 있으니까."*

8명의 AI 분석가가 매일 일하고, 매주 회고하고, 6개월 후 진짜 똑똑해지는 시스템 — 이게 베이영님이 원하셨던 *"AI 직원 7명과 함께 일하는 트레이딩 데스크"*의 구체적 형태입니다.

설계가 끝났으니, 이제 *만들 차례*입니다.

---

**🎯 현재 상태: 설계 완료, 구현 대기 중**
**🚀 다음 단계: M1 인프라 구축**

---

*문서 길이 합계: 약 230KB (15개 파일)*
*총 문서 분량을 인쇄하면 약 200-250 페이지*
*완독에 필요한 시간: 약 3-4시간 (꼼꼼히), 1시간 (요약)*
