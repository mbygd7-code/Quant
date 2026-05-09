# 🕸️ 캐릭터 관계 매트릭스

> **QuantSignal 시스템 통합 정의서 v1.0**
> 8명 캐릭터 간의 모든 관계(견제·협력·위임·중립)를 정의.
> 이 매트릭스가 시스템의 *토론 품질*을 결정한다.

---

## 0. 설계 원칙

1. **관계는 비대칭일 수 있다** — A가 B를 견제해도 B가 A를 견제하지 않을 수 있음
2. **모든 관계가 동등하지 않다** — 강한 견제축 vs 약한 협력 구별
3. **관계는 트리거가 있다** — 항상 발동하는 게 아니라 특정 조건에서만
4. **충돌 해결 규칙은 결정론적** — 누가 이기는지 사전 정의

---

## 1. 관계 유형 4가지

| 유형 | 의미 | 예시 |
|---|---|---|
| **🔥 견제 (Tension)** | 정반대 관점에서 같은 사안을 봄. 토론의 핵심 | Graham ↔ Dow |
| **🤝 협력 (Collaboration)** | 한쪽 출력이 다른 쪽 입력으로 흐름 | Keynes → Simons (피처 제공) |
| **📤 위임 (Delegation)** | 한쪽이 다른 쪽에 일을 던짐 | Turing → 모든 분석가 |
| **➖ 중립 (Neutral)** | 직접 상호작용 없음 | Turing ↔ Taleb |

---

## 2. 전체 관계 매트릭스 (8×8)

| | Soros | Taleb | Simons | Graham | Dow | Shiller | Keynes | Turing |
|---|---|---|---|---|---|---|---|---|
| **Soros** | — | 🔥 강견제 | 📤 위임 | 📤 위임 | 📤 위임 | 📤 위임 | 📤 위임 | ➖ |
| **Taleb** | 🔥 강견제 | — | 🔥 강견제 | 🤝 협력 | 🔥 약견제 | 🔥 약견제 | 🤝 협력 | ➖ |
| **Simons** | 🤝 점수제공 | 🔥 강견제 | — | 🤝 피처활용 | 🤝 피처활용 | 🔥 강견제 | 🤝 피처활용 | ➖ |
| **Graham** | 🤝 점수제공 | 🤝 협력 | 🤝 피처제공 | — | 🔥 강견제 | 🤝 협력 | 🤝 협력 | ➖ |
| **Dow** | 🤝 점수제공 | 🔥 약견제 | 🤝 피처제공 | 🔥 강견제 | — | 🔥 약견제 | 🔥 약견제 | ➖ |
| **Shiller** | 🤝 점수+Q2 | 🔥 약견제 | 🔥 강견제 | 🤝 협력 | 🔥 약견제 | — | 🤝 협력 | ➖ |
| **Keynes** | 🤝 점수제공 | 🤝 협력 | 🤝 피처제공 | 🤝 협력 | 🔥 약견제 | 🤝 협력 | — | ➖ |
| **Turing** | 📤 라우팅 | 📤 라우팅 | 📤 라우팅 | 📤 라우팅 | 📤 라우팅 | 📤 라우팅 | 📤 라우팅 | — |

**범례**:
- 🔥 강견제: 같은 사안에 정반대 결론 가능, 빈번 충돌
- 🔥 약견제: 가끔 충돌, 시간 축이나 관점 차이로 인한
- 🤝 협력: 데이터/피처/점수 흐름
- 📤 위임: 일을 던지는 일방향
- ➖ 중립: 직접 상호작용 없음

---

## 3. 핵심 견제축 4개 (시스템의 척추)

### 3.1 견제축 1: Graham ↔ Dow (가치 vs 추세)

**관계 강도**: 🔥🔥🔥 강견제 (시스템의 가장 빈번한 충돌)

**충돌 메커니즘**:
```
같은 종목에 대해:
  Graham: 본질가치 평가 → "고평가/저평가"
  Dow:    추세 진단 → "상승세/하락세"

이 둘이 정반대일 때 충돌:
  Case A: Graham "고평가" + Dow "강한 상승세"
          → 거품기 진입 가능성
  Case B: Graham "저평가" + Dow "강한 하락세"
          → 가치 함정 가능성
```

**발동 빈도**: 매우 높음 (시장의 1/3 종목에서 발생)

**충돌 해결 규칙**:
- 두 의견이 0.5점 이상 갈리면 → Soros가 자동으로 *깊이 검토 모드*
- Soros는 추가로 Shiller·Taleb 의견을 반드시 참조
- Soros의 Q2(시장 반영도)가 결정적 요인

**역사적 사례 활용**:
- "고평가 + 상승세 → 거품" 케이스: 1999 닷컴, 2000 IT, 2007 부동산, 2021 메타버스
- "저평가 + 하락세 → 가치 함정" 케이스: 코닥, 노키아, 한진해운

**사용자에게 보여줄 때**:
- 두 캐릭터 의견을 *나란히* 표시
- Soros의 종합 판단을 강조
- 사용자가 어느 쪽을 더 신뢰할지 결정

---

### 3.2 견제축 2: Simons ↔ Shiller (효율 시장 vs 비합리 시장)

**관계 강도**: 🔥🔥🔥 강견제 (가장 학술적·철학적 대립)

**충돌 메커니즘**:
```
시장관 자체가 정반대:
  Simons:  "데이터로 모든 게 설명된다 (효율적 시장)"
           ML 모델로 종목 예측
  Shiller: "시장은 비합리적이다 (군중 심리)"
           PE10·내러티브로 사이클 진단

이 둘이 정반대일 때 충돌:
  Case A: Simons "BUY 신호" + Shiller "거품 경고"
          → 단기 모멘텀 vs 장기 거품 충돌
  Case B: Simons "SELL 신호" + Shiller "capitulation"
          → 단기 약세 vs 장기 매수 기회
```

**발동 빈도**: 중간 (특히 시장 사이클 극단기에 빈번)

**충돌 해결 규칙**:
- 시간 축이 다르므로 *둘 다 옳을 수 있음*
- Soros는 사용자의 *투자 시계(time horizon)*에 따라 가중치 조정
- 단기 투자자: Simons 우선
- 장기 투자자: Shiller 우선
- 일반: Soros가 두 의견을 포트폴리오 비중으로 표현 (예: 50% 매수, 추가 매수 보류)

**역사적 사례 활용**:
- 1999년: Simons 같은 모델은 BUY, Shiller는 거품 경고 → Shiller 적중
- 2008년 말: Simons 같은 모델은 SELL, Shiller는 capitulation → Shiller 적중
- 2020년 3월: Simons는 SELL, Shiller는 capitulation → Shiller 적중

**핵심 차별점**: Shiller는 *극단기*에 강하고, Simons는 *정상기*에 강함

---

### 3.3 견제축 3: Soros ↔ Taleb (결정 vs 검증)

**관계 강도**: 🔥🔥🔥 강견제 (가장 명시적 자동 견제)

**충돌 메커니즘**:
```
Soros: 6명 분석가 의견 종합 → BUY 시그널 결정
Taleb: 그 결정에 *반드시* 반박 시도
        → severity 1-5로 위험 평가

자동 제약 규칙:
  Taleb severity 4 → Soros 시그널 한 단계 자동 하향
  Taleb severity 5 → Soros HOLD 이상 강제, 비중 0%
```

**발동 빈도**: 매번 (모든 결정에 자동 발동)

**충돌 해결 규칙**:
- Soros는 Taleb severity 4-5를 *무시할 수 없음* (시스템 강제)
- 단, Soros가 *이유 명시하면* severity 3 이하는 무시 가능
- 모든 무시 사례는 `taleb_override` 로그에 기록

**비대칭의 의도**: 
- Taleb의 영향력을 시스템적으로 강제
- Soros가 *함부로 강한 BUY 못 하게* 안전장치

**사후 학습**:
- Taleb 무시 후 결과 추적
- 6개월 누적 데이터로 임계값 조정 (거짓 경고 많으면 임계값 ↑)

---

### 3.4 견제축 4: Simons ↔ Taleb (모델 vs 모델 의심)

**관계 강도**: 🔥🔥🔥 강견제 (가장 빈번한 데이터 검증)

**충돌 메커니즘**:
```
Simons: GBM 모델 → "상승확률 72%, confidence 0.82"
Taleb:  Check 2 (모델 정확도 의심) → 항상 자동 검증

검증 항목:
  - Simons의 최근 6개월 정확도가 60% 미만? → severity ↑
  - confidence 높은데 비슷한 시그널 자주 빗나갔나?
  - 학습 데이터에 없는 상황 (예: 메모리 사이클 정점)?
```

**발동 빈도**: 매번 (Simons 출력 시 Taleb 자동 검증)

**충돌 해결 규칙**:
- Taleb이 Simons 모델 정확도를 *지속 추적*
- 정확도 50% 미만 → Simons 가중치 자동 -50% (해당 종목)
- 학습 데이터 범위 밖 상황 → severity +1

**시스템적 의미**:
- ML 모델의 오버컨피던스 자동 차단
- 사용자에게 *"이 신호는 모델이 본 적 없는 상황"* 경고

---

## 4. 강한 협력 관계 6개

### 4.1 Keynes → Simons (피처 제공)
**흐름**: Keynes의 매크로 변수 + 섹터 베타 → Simons GBM 피처
**효과**: ML 모델에 매크로 정보 자동 반영

### 4.2 Graham → Simons (피처 제공)
**흐름**: Graham의 quality_score, intrinsic_value → Simons GBM 피처
**효과**: 펀더멘털 정보가 ML 예측에 간접 반영

### 4.3 Dow → Simons (피처 제공)
**흐름**: Dow의 추세 진단 → Simons GBM 피처
**효과**: 모멘텀 신호가 ML 예측에 간접 반영

### 4.4 Keynes → Graham (할인율)
**흐름**: Keynes의 무위험 수익률 → Graham DCF 할인율
**효과**: Graham의 본질가치 계산이 매크로 환경 반영

### 4.5 Shiller → Soros (Q2 핵심 입력)
**흐름**: Shiller의 시장 사이클 단계 → Soros의 Q2 평가
**효과**: 가중치는 0.13이지만 *간접 영향력은 가장 큼*

### 4.6 Graham ↔ Taleb (회계 이상 양방향 협력)
**흐름**:
- Taleb Check 3에서 회계 이상 발견 → Graham에 알림 (재평가 트리거)
- Graham의 anomaly_flags → Taleb에 알림 (시나리오 강화)

**효과**: 회계 부정 감지의 이중 안전장치

---

## 5. 약한 견제 관계 5개

### 5.1 Dow ↔ Shiller (시간 축 차이)
**충돌 케이스**: Dow "단기 추세 강함" + Shiller "장기 거품 경고"
**해결**: 시간 축 차이 명시, 사용자가 자기 투자 시계로 선택

### 5.2 Dow ↔ Keynes (단기 vs 매크로)
**충돌 케이스**: Dow "강한 상승세" + Keynes "매크로 악재"
**해결**: Keynes가 시차 명시 → Soros가 시차에 따라 가중

### 5.3 Taleb ↔ Dow (추세 의심)
**충돌 케이스**: Dow "거래량 동반 상승" + Taleb "정점 임박"
**해결**: Dow가 단계 4-5 진단 시 자동으로 Taleb에 알림 → 시나리오 강화

### 5.4 Taleb ↔ Shiller (시기와 강도)
**충돌 케이스**: Shiller "거품 경고 발행" + Taleb "이미 우려 중"
**해결**: 협력으로 전환 (둘 다 같은 방향이면 시그널 강화)

### 5.5 Simons ↔ Graham (단기 vs 장기 평가)
**충돌 케이스**: Simons "단기 강한관심" + Graham "장기 고평가"
**해결**: Soros가 사용자 투자 시계로 가중

---

## 6. 위임 관계 (Turing의 라우팅)

Turing → 7명 모두에게 일방향 위임:

| 사용자 의도 | Turing 라우팅 대상 |
|---|---|
| 차트·추세·진입 타이밍 | Dow |
| 본질가치·안전마진·재무 | Graham |
| 정량 예측·포트폴리오 | Simons |
| 시장 사이클·거품·심리 | Shiller |
| 매크로·정책·환율 | Keynes |
| 위험·반박 | Taleb |
| 종합·결론·매수 결정 | Soros |
| 시스템·도움말 | (Turing 직접 응답) |

**비대칭 강조**: 이 관계는 *완전 일방향*. 다른 캐릭터들은 Turing에 응답을 돌려보내지만 *Turing을 호출하지는 않음*.

---

## 7. 충돌 해결 우선순위 (Decision Hierarchy)

여러 관계가 동시에 발동될 때의 우선순위:

```
Level 1 (절대): Taleb severity 5 → 강제 HOLD 이상, 비중 0%
                ↓ 무시 불가
Level 2 (강제): Taleb severity 4 → 시그널 한 단계 하향
                ↓ Soros 자유도 없음
Level 3 (사용자): 사용자 가중치 설정 ±50% 한도
                ↓ 강제 정규화
Level 4 (Soros): 가중치 조정, 경계선 판단, narrative
                ↓ 자유 행사 가능 (이유 명시)
Level 5 (개별 캐릭터): 각자 점수 산출, 자유 ±0.3
                ↓ 정의된 공식 내
Level 6 (라우팅): Turing의 분류 정확도
```

**핵심 원칙**: 위 레벨이 아래 레벨을 항상 이김.

---

## 8. 관계 발동 트리거

언제 어떤 관계가 발동되는지 정의.

### 매번 발동 (모든 분석 사이클)
- Turing → 모든 캐릭터 (라우팅)
- Soros ← 모든 캐릭터 (점수 수집)
- Taleb → Soros (자동 제약)
- Simons → Taleb (정확도 검증)

### 자주 발동 (분석의 30-50%)
- Graham ↔ Dow (가치 vs 추세 충돌)
- Keynes → Simons/Graham (피처·할인율 제공)

### 가끔 발동 (특정 상황)
- Simons ↔ Shiller (시장 사이클 극단기)
- Shiller → Soros Q2 (시장 반영도)
- Graham ↔ Taleb (회계 이상 발견 시)

### 드물게 발동 (10% 미만)
- Dow ↔ Shiller (시간 축 충돌)
- Dow ↔ Keynes (매크로 vs 추세)
- Taleb ↔ Shiller (거품 단계 협력)

---

## 9. 시각적 관계 다이어그램

```
                              [사용자]
                                  │
                                  ▼
                            ┌──────────┐
                            │  Turing  │ (조용한 라우터)
                            │ 의도분류  │
                            └──┬───────┘
                               │ 위임
        ┌───────┬──────┬───────┼──────┬──────┬────────┐
        ▼       ▼      ▼       ▼      ▼      ▼        ▼
   ┌────────┐┌─────┐┌─────┐┌────────┐┌─────┐┌────────┐
   │ Simons ││Graham││ Dow ││Shiller ││Keynes││ Taleb │
   │ 정량   ││ 가치 ││ 추세 ││ 사이클 ││매크로││ 위험  │
   └───┬─┬──┘└──┬──┘└──┬──┘└────────┘└──┬──┘└────┬───┘
       │ │     │     │                  │        │
       │ │     ↕견제↕                   │        │
       │ │  Graham↔Dow                  │        │
       │ │                              │        │
       │ ↕━━━━━━ 강견제 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
       │     Simons ↔ Shiller                              ┃
       │                                                   ┃
       │ ←─── 피처 ────── Keynes ──── Graham ──── Dow      ┃
       │                                                   ┃
       │ ←─────────── 검증 ─────────────────────────── Taleb
       │                                                   │
       └─────── 점수 ─────────────────────┐                │
                                          ▼                ▼
                                    ┌──────────┐
                                    │  Soros   │
                                    │ 종합결정 │
                                    └────┬─────┘
                                         │
                                         ▼
                                    [최종 시그널]
                                         │
                                         ▼
                                      [사용자]
```

---

## 10. 토론 시뮬레이션 — 이상적인 의사결정 흐름

### 케이스: SK하이닉스 분석 (2024년 후반 가상)

**Step 1: 사용자 질문**
> 사용자: "SK하이닉스 지금 사도 돼?"

**Step 2: Turing 라우팅**
- 의도: synthesis (종합 결론)
- 라우팅: Soros

**Step 3: Soros가 6명 분석가 호출 (병렬)**

| 캐릭터 | 점수 | 핵심 의견 |
|---|---|---|
| Simons | +1.5 | "GBM 강한관심, 상승확률 72%" |
| Graham | -1.0 | "PER 18배, 본질가치 대비 -11%" |
| Dow | +1.5 | "200일선 정배열, 강한 상승세 단계 3" |
| Shiller | -1.0 | "반도체 PE10 상위 8%, AI 거품 강도 88" |
| Keynes | -0.5 | "환율 +2%, 반도체 영향 -3.2%" |
| Taleb | severity 4 | "메모리 사이클 정점 가능성" |

**Step 4: 견제축 발동 감지**
- Graham ↔ Dow: 강한 충돌 (-1.0 vs +1.5)
- Simons ↔ Shiller: 강한 충돌 (+1.5 vs -1.0)
- Taleb severity 4: 자동 시그널 하향

**Step 5: Soros의 종합**
```python
weighted_sum = 
  Simons +1.5 × 0.20  = +0.30
  Graham -1.0 × 0.18  = -0.18
  Dow    +1.5 × 0.18  = +0.27
  Shiller -1.0 × 0.13 = -0.13
  Keynes -0.5 × 0.18  = -0.09
  Taleb  -2.0 × 0.13  = -0.26  (severity 4의 risk_score)
  = -0.09 (weighted_score)

Q2: priced_in = 0.82 (높음, AI 거품 진행 중)
   → adjusted_score = -0.09 × 0.5 = -0.045

Q3: Taleb severity 4 → 시그널 한 단계 하향 (자동)
   → 원래 BUY 가능성도 WATCH 한 단계 하향

최종 시그널: HOLD
비중: 30% (현재 보유 시)
```

**Step 6: Soros의 narrative**
> "SK하이닉스에 대해 의견이 크게 갈렸어요. Simons와 Dow는 강한 매수 신호를 냈지만, Graham은 PER 18배로 고평가를 우려했고 Shiller는 반도체 섹터가 역사적 상위 8% 거품 영역이라고 봤습니다. 게다가 Taleb이 메모리 사이클 정점 가능성을 강하게 제기했어요(severity 4).
> 
> 데이터는 좋지만 시장이 이미 충분히 반영했고, 거품 위험까지 있는 상황 — 추가 매수는 권하지 않고, 현재 보유분도 일부 축소를 검토할 만합니다. 
> 
> 최종 시그널: **HOLD**, 비중 30% 권장."

---

## 11. 견제 관계의 강도 추적 (학습)

시간이 지나며 어느 견제축이 *가치 있는지* 측정.

```sql
create table tension_outcomes (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,
  ticker text not null,
  
  -- 어느 견제축이 발동됐는가
  tension_type text,                  -- 'graham_vs_dow', 'simons_vs_shiller' 등
  
  -- 양측 의견
  side_a_score numeric,               -- 예: Graham -1.0
  side_b_score numeric,               -- 예: Dow +1.5
  divergence numeric,                 -- |a - b|
  
  -- Soros의 결정
  soros_decision text,                -- 어느 쪽 손 들어줬나
  
  -- 사후 결과 (1개월/3개월 후 갱신)
  outcome_1m numeric,                 -- 실제 수익률
  outcome_3m numeric,
  
  created_at timestamptz default now()
);
```

### 견제축 가치 분석 (월간 자동)

```
SELECT 
  tension_type,
  COUNT(*) as cases,
  AVG(divergence) as avg_disagreement,
  
  -- Soros가 어느 쪽 손 들었을 때 더 잘 맞았나?
  AVG(CASE WHEN soros_decision = 'side_a' THEN outcome_1m END) as side_a_outcome,
  AVG(CASE WHEN soros_decision = 'side_b' THEN outcome_1m END) as side_b_outcome
FROM tension_outcomes
WHERE created_at > now() - interval '6 months'
GROUP BY tension_type;
```

**예상 인사이트** (6개월 후):
- "Graham ↔ Dow 충돌에서 Soros가 Graham 편 들었을 때 1개월 평균 +2.3%"
- "Simons ↔ Shiller 충돌에서 Shiller 편이 장기 더 정확"

→ 이 인사이트가 Soros의 가중치 조정 근거가 됨

---

## 12. 미해결 항목

- [ ] **견제축 강도 임계값**: divergence 얼마부터 "충돌"로 분류?
- [ ] **다중 충돌 처리**: 여러 견제축이 동시 발동 시 우선순위?
- [ ] **사용자 알림 정책**: 충돌 감지 시 매번 알릴지, 큰 충돌만 알릴지?
- [ ] **새 관계 추가 메커니즘**: 시간이 지나며 새 관계 발견 시 추가 방법?

---

**다음 단계: 데이터 플로우 다이어그램 (전체 시스템 + 8명 캐릭터 + Supabase + PC 워커)**
