# ⚖️ 캐릭터 가중치 설정 시스템

> **QuantSignal 시스템 정의서 v1.0**
> 사용자가 6명 캐릭터의 영향력을 직접 통제하면서, Soros에게는 시장 상황별 임시 조정 자유를 허용하는 이중 구조.

---

## 0. 설계 원칙

1. **사용자가 최종 통제권**. Soros조차 사용자가 정한 범위를 벗어날 수 없음.
2. **추천값은 학술적 근거 기반**. 막연한 직감이 아닌 인용 가능한 출처.
3. **Soros 자유도는 고정 (±50%)**. 너무 좁으면 적응 못 하고, 너무 넓으면 사용자 의도 무력화.
4. **변경 이력은 모두 학습 데이터**. 가중치 조정의 효과를 6개월 후 측정 가능하게 함.
5. **Taleb은 특수**. 최소 가중치 10% 강제 (시스템 안전 장치).

---

## 1. 추천 기본값 (Recommended Default Weights)

### 분포

| 캐릭터 | 기본값 | 영역 | 근거 |
|---|---:|---|---|
| **Markowitz** | 0.20 | 정량 모델 | AQR Capital, Two Sigma 정량 헤지펀드의 팩터 모델 표준 분포 (Asness et al., 2013) |
| **Graham** | 0.18 | 펀더멘털·가치 | 파마-프렌치 5팩터 모델의 가치 팩터 장기 알파 기여 (Fama & French, 1992) |
| **Dow** | 0.18 | 기술적·모멘텀 | AQR "A Century of Evidence on Trend-Following" (2012) |
| **Shiller** | 0.13 | 센티먼트 | Baker & Wurgler "Investor Sentiment in the Stock Market" (2007) |
| **Keynes** | 0.18 | 매크로 | Bridgewater All Weather 가중치 + 한국 시장 매크로 민감도 |
| **Taleb** | 0.13 | 리스크 | Spitznagel "Safe Haven" (2021) Universa Investments 가이드 |
| **합계** | **1.00** | | |

### 영역 별 분포 검증

| 영역 | 비중 | 캐릭터 |
|---|---:|---|
| 펀더멘털 | 38% | Markowitz + Graham |
| 시장 분석 | 31% | Dow + Shiller |
| 거시·리스크 | 31% | Keynes + Taleb |

→ 어느 한 영역도 50% 넘지 않음. 균형 유지.

### 추천값의 강조점

- **Markowitz가 가장 높음 (0.20)**: 정량 분석은 다른 모든 신호의 출발점
- **Shiller·Taleb이 가장 낮음 (0.13)**: 둘 다 *질적 판단* 영역. 정량 신호 대비 신뢰도 변동성 큼
- **Keynes가 0.18로 비교적 높음**: 한국 시장은 환율·미국 금리 영향이 크다는 학술적 합의

---

## 2. 사용자 설정 제약

### 각 캐릭터 범위

| 캐릭터 | 최소 | 최대 | 특이사항 |
|---|---:|---:|---|
| Markowitz | 5% | 40% | |
| Graham | 5% | 40% | |
| Dow | 5% | 40% | |
| Shiller | 5% | 40% | |
| Keynes | 5% | 40% | |
| **Taleb** | **10%** | 40% | **최소 10% 강제** |

### 합계 규칙

- 항상 **합계 = 100%**
- 사용자가 한 캐릭터를 올리면 다른 캐릭터들이 비례 축소 (자동 정규화)
- 정규화 후 5%(또는 Taleb 10%) 미만이 되면 **변경 불가** 알림

### Taleb 최소 10% 강제 이유

```
사용자가 Taleb = 0% 설정 시 발생할 일:
→ 위험 평가 없이 BUY 결정 가능
→ severity 4-5 자동 제약은 별개로 작동하지만, Q1 가중 합산에서 위험이 무시됨
→ 시스템 안전성의 근본을 무너뜨림

따라서:
→ Taleb은 의견을 줄일 수는 있어도, 완전히 침묵시킬 수는 없음
```

### 극단 시나리오 차단

| 시나리오 | 차단 메커니즘 |
|---|---|
| 한 캐릭터에 80% 몰빵 | 최대 40% 제한 |
| 리스크 검증 비활성화 | Taleb 최소 10% |
| 모든 캐릭터 균등 (16.7%) | 허용됨 (사용자 자유) |

---

## 3. Soros의 임시 조정 자유도

### 자유도 ±50% 의미

```
사용자 설정: Markowitz 0.20

Soros의 조정 가능 범위:
  최소: 0.20 × (1 - 0.50) = 0.10
  최대: 0.20 × (1 + 0.50) = 0.30
```

Soros는 이 범위 *내에서만* 시장 상황별로 가중치를 변경할 수 있음.

### 정규화 처리

Soros가 한 캐릭터의 가중치를 변경하면 다른 캐릭터들이 비례 조정되어 합계 1.0 유지:

```python
def soros_adjust_weights(user_weights, target_agent, new_value):
    # 한도 체크
    user_value = user_weights[target_agent]
    min_allowed = user_value * 0.5
    max_allowed = user_value * 1.5
    new_value = clamp(new_value, min_allowed, max_allowed)
    
    # 다른 캐릭터들 비례 축소/확대
    others_total = sum(user_weights.values()) - user_value
    new_others_total = 1.0 - new_value
    scale = new_others_total / others_total
    
    adjusted = {}
    for agent, weight in user_weights.items():
        if agent == target_agent:
            adjusted[agent] = new_value
        else:
            adjusted[agent] = weight * scale
    
    return adjusted
```

### 자유도 행사 예시

> **사용자 설정**:
> M=0.20, G=0.18, D=0.18, S=0.13, K=0.18, T=0.13
> 
> **상황**: FOMC 발표일 아침
> 
> **Soros 판단**: "매크로 영향이 압도적이니 Keynes를 최대치(0.18 × 1.5 = 0.27)로 올림"
> 
> **자동 정규화 후 가중치**:
> - Keynes: 0.18 → **0.27**
> - 나머지: (1 - 0.27) ÷ (1 - 0.18) = 0.89 비례 축소
>   - Markowitz: 0.20 → 0.178
>   - Graham: 0.18 → 0.160
>   - Dow: 0.18 → 0.160
>   - Shiller: 0.13 → 0.116
>   - Taleb: 0.13 → 0.116
> 
> **합계**: 1.000 ✓

### Soros가 자유 행사할 수 있는 트리거

| 상황 | 가중치 조정 방향 |
|---|---|
| FOMC, 한은 금통위 당일 | Keynes ↑ |
| 어닝 시즌 | Graham ↑ |
| 시장 변동성 급등 (VIX > 25) | Taleb ↑ |
| 강한 추세 형성기 | Dow ↑ |
| 시장 과열/공포 극단 | Shiller ↑ |
| 정량 모델 정확도 하락기 | Markowitz ↓ |

---

## 4. 데이터베이스 스키마

### 사용자 가중치 설정

```sql
create table user_weight_settings (
  user_id uuid references auth.users(id) primary key,
  
  -- 가중치 (정규화된 값, 합계 = 1.0)
  weight_markowitz numeric(4,3) default 0.200,
  weight_graham    numeric(4,3) default 0.180,
  weight_dow       numeric(4,3) default 0.180,
  weight_shiller   numeric(4,3) default 0.130,
  weight_keynes    numeric(4,3) default 0.180,
  weight_taleb     numeric(4,3) default 0.130,
  
  -- 제약 검증
  constraint weights_sum_to_one check (
    abs(weight_markowitz + weight_graham + weight_dow + 
        weight_shiller + weight_keynes + weight_taleb - 1.0) < 0.001
  ),
  constraint min_weights check (
    weight_markowitz >= 0.05 AND weight_markowitz <= 0.40 AND
    weight_graham    >= 0.05 AND weight_graham    <= 0.40 AND
    weight_dow       >= 0.05 AND weight_dow       <= 0.40 AND
    weight_shiller   >= 0.05 AND weight_shiller   <= 0.40 AND
    weight_keynes    >= 0.05 AND weight_keynes    <= 0.40 AND
    weight_taleb     >= 0.10 AND weight_taleb     <= 0.40
  ),
  
  -- 사용자 프로필 (강화 학습용)
  risk_profile text check (risk_profile in ('conservative', 'balanced', 'aggressive')),
  
  -- 메타
  last_modified_at timestamptz default now(),
  modified_count int default 0
);
```

### 변경 이력 (강화 학습용)

```sql
create table weight_settings_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  
  -- 변경 전후 (JSON으로 6명 가중치 모두 저장)
  weights_before jsonb not null,
  weights_after jsonb not null,
  
  -- 변경 이유 (사용자가 적을 수 있음)
  user_reason text,
  
  -- 변경 시점
  changed_at timestamptz default now()
);
```

### Soros 임시 조정 로그

```sql
create table soros_weight_adjustments (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null,                        -- 분석 사이클
  user_id uuid references auth.users(id),
  
  user_base_weights jsonb not null,              -- 사용자 설정값
  soros_adjusted_weights jsonb not null,         -- Soros 조정값
  
  trigger_event text,                            -- 'fomc_day', 'earnings_season', 등
  reason text not null,                          -- Soros가 적은 사유
  
  created_at timestamptz default now()
);
```

---

## 5. UI 설계

### 설정 화면

```
┌─────────────────────────────────────────────────┐
│  ⚙️ 캐릭터 가중치 설정                          │
├─────────────────────────────────────────────────┤
│                                                 │
│  📊 Markowitz (정량 모델)                       │
│  ━━━━━━━━━━━●━━━━━━━━━━ 20%  [기본값]          │
│  💡 정량 헤지펀드 표준 분포 기반                │
│                                                 │
│  💎 Graham (펀더멘털·가치)                      │
│  ━━━━━━━━━●━━━━━━━━━━━━ 18%  [기본값]          │
│  💡 파마-프렌치 5팩터 가치 팩터 기여            │
│                                                 │
│  📈 Dow (기술적·추세)                           │
│  ━━━━━━━━━●━━━━━━━━━━━━ 18%  [기본값]          │
│  💡 AQR Trend Following 100년 데이터            │
│                                                 │
│  💭 Shiller (센티먼트)                          │
│  ━━━━━━●━━━━━━━━━━━━━━━ 13%  [기본값]          │
│  💡 단기 영향력은 크나 장기로 회귀              │
│                                                 │
│  🌍 Keynes (매크로)                             │
│  ━━━━━━━━━●━━━━━━━━━━━━ 18%  [기본값]          │
│  💡 한국 시장 매크로 민감도 반영                │
│                                                 │
│  🦅 Taleb (리스크)                              │
│  ━━━━━━●━━━━━━━━━━━━━━━ 13%  [기본값]          │
│  💡 꼬리위험 헤지 권고 비중                     │
│  ⚠️ 최소 10% 보장 (시스템 안전 장치)            │
│                                                 │
│  ─────────────────────────────────              │
│  합계: 100% ✓                                   │
│                                                 │
│  [기본값 복원]  [저장]                          │
│                                                 │
│  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
│                                                 │
│  ℹ️ Soros는 시장 상황(FOMC, 어닝, 변동성 급등) │
│     에 따라 위 값을 ±50% 범위에서 임시 조정    │
│     할 수 있습니다.                             │
│                                                 │
│  Soros의 자유도: [-50%]━━━●━━━[+50%] (고정)     │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 주요 인터랙션

1. **슬라이더 조작**: 한 캐릭터를 올리면 나머지가 비례 축소 (실시간 정규화)
2. **제한 도달 시**: 최소/최대 한도 도달하면 슬라이더가 멈추고 짧은 알림
3. **기본값 복원**: 한 클릭으로 추천값으로 리셋
4. **저장 시**: 변경 이력이 자동 기록 (`weight_settings_history`)

### 부가 정보 표시 (선택 영역)

```
┌─────────────────────────────────────────────────┐
│  📊 내 설정의 영향                              │
├─────────────────────────────────────────────────┤
│                                                 │
│  현재 설정 시작 후 (3개월):                     │
│  • 시그널 적중률: 67% (시스템 평균 64%)         │
│  • 평균 수익률: +4.2% (시스템 평균 +3.8%)       │
│  • Soros 자유 행사 횟수: 12회                   │
│                                                 │
│  [상세 분석 보기]                                │
└─────────────────────────────────────────────────┘
```

---

## 6. 강화 학습 연결

### 학습 데이터로서의 가중치

```sql
-- 사용자의 가중치 변경과 그 이후 성과를 연결
SELECT 
  wsh.user_id,
  wsh.weights_after,
  wsh.changed_at,
  
  -- 변경 이후 1개월 시그널 적중률
  (SELECT avg(case when fs.outcome = 'correct' then 1.0 else 0.0 end)
   FROM final_signals fs
   WHERE fs.user_id = wsh.user_id
     AND fs.created_at BETWEEN wsh.changed_at AND wsh.changed_at + interval '1 month'
  ) as accuracy_1m
  
FROM weight_settings_history wsh
ORDER BY wsh.changed_at;
```

### Soros가 학습하는 것

6개월 누적 후 Soros는 다음을 학습:

1. **사용자별 최적 가중치**: 이 사용자에게는 Taleb 0.20이 시그널 적중률을 높이더라
2. **상황별 최적 조정 패턴**: FOMC 당일 Keynes를 최대치로 올렸을 때 적중률 +X%
3. **자유 행사의 가치**: Soros가 임시 조정한 결정 vs 사용자 설정 그대로 따른 결정의 적중률 차이

### 사용자에게 자동 추천

```
6개월 후 Soros의 메시지:
"지난 6개월간의 데이터를 분석한 결과, 베이영님의 투자 패턴에는 
Taleb의 가중치를 0.13에서 0.18로 높이는 게 적중률을 약 4% 
향상시킬 것으로 보입니다. 적용해보시겠어요? [적용] [무시]"
```

이게 **시스템이 똑똑해지는 가시적 증거**가 됨. 베이영님이 강조하신 *"강화 효과의 신뢰"*가 여기서 만들어진다.

---

## 7. 미해결 항목

- [ ] **상황 트리거 자동 감지**: FOMC 캘린더, 어닝 시즌, VIX 임계치 데이터 소스 확정 필요
- [ ] **Soros 임시 조정의 영구화 임계**: 같은 조정이 반복되면 사용자에게 영구 적용 제안 (며칠 누적이 적정?)
- [ ] **사용자 다중 프로필**: 보수/공격용 가중치 세트를 둘 이상 저장하고 전환?
- [ ] **백테스트 도구**: 사용자가 가중치 변경 전 효과를 미리 보기 (과거 6개월에 적용했다면 어땠는지)

---

## 8. 다른 캐릭터 정의서와의 연결

### Soros 정의서
- Q1 가중 합산 시 `load_user_weight_settings()` 호출
- ±50% 자유도 내에서 `soros_decide_weights()` 실행
- 조정 시 `soros_weight_adjustments`에 기록

### Taleb 정의서
- 자기 가중치 최소 10% 강제 (다른 캐릭터와 다름)
- 사용자가 Taleb을 0%로 만들려 시도 시 시스템이 차단

### 향후 작성될 5명 정의서
- 각자의 가중치 기본값과 범위는 본 문서를 참조
- 추천값 변경이 필요하면 본 문서를 업데이트하고 정의서들과 동기화
