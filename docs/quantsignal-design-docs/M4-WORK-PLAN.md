# 🟧 M4 — Taleb 작업 계획서

> **목표**: 리스크 와처 추가, Q3 자동 제약 활성화, 5명이 Soros 종합.
> **선결 조건**: M3 머지·배포 완료, 4명 사이클이 1주 안정 운영.
> **원칙**: M1·M2·M3과 동일 — Strangler Fig, 신규 파일만.

---

## 0. M4 단순화 결정 (정의서 ↔ 구현 차이)

캐릭터 정의서는 4-체크(비대칭/모델 의심/Unknown/시나리오) + 시나리오별 historical_reference RAG 검색 + 누적 정확도 추적을 가정. M2/M3과 같은 원칙으로, **이미 적재된 데이터로 만들 수 있는 가장 정직한 근사**부터:

| 정의서 항목 | M4 구현 |
|---|---|
| **Check 1** 비대칭 (upside/downside) | 252일 변동성, 일일 최대 하락폭, Markowitz `score_predictions` 대체로 watchlist 평균 PER 분포 위치 |
| **Check 2** 다른 캐릭터 정확도 의심 | M4 미구현 — `agent_outputs`에 충분한 결과가 없음. 자리표시자(`accuracy_lookup=null`). 정식 구현은 M5+에서 누적 정확도 백필 후 |
| **Check 3** Unknown unknowns (어닝/정치/기술) | 어닝일자 D-7만 구현 (`kr_financials.period_end` 기반 추정). 정치·기술·재무이상은 M5+ |
| **Check 4** 꼬리위험 시나리오 | LLM이 4-체크 raw_payload를 보고 1~3개 시나리오 작성. RAG 인용은 M5+ |
| `risk_assessments` 별도 테이블 | M4는 `agent_outputs.raw_payload`로 통합 (스키마 추가 없음) |
| `risk_alerts` 별도 테이블 | M4는 severity ≥ 4를 `v_taleb_alerts_recent` 뷰로 surface (이미 M1에 존재) |

핵심은 **Q3 자동 제약**의 작동: severity 4면 한 단계 하향, severity 5면 BUY/STRONG_BUY를 HOLD로 강제. `apply_taleb_constraint` 헬퍼는 M1-grading.py에 이미 존재 — M4는 이걸 Soros 합성에 wire-in 한다.

---

## 1. 작업 묶음 (T1~T5)

| Task | 항목 | 예상 |
|:---:|---|---:|
| **T1** | `agents/characters/taleb.py` — 4-체크 계산 + severity 산출 + LLM 시나리오 narrative | 4h |
| **T2** | Soros — `synthesize_m4` 메서드 (5-voter Q1 + Q3 자동 제약). M3 path 보존 | 2h |
| **T3** | `agents/cycle/run_m4_cycle.py` 신규, M3 cycle은 보존 | 1h |
| **T4** | 단위 테스트 + 통합 테스트 (severity 4/5 강제 하향 시나리오) | 2.5h |
| **T5** | `.github/workflows/agents-cycle.yml` → M4 runner 호출 | 0.5h |

**총 예상**: ~10h.

---

## 2. T1 Taleb 알고리즘 (M4 단순화)

```
입력 데이터:
  - daily_quotes(ticker, days=252)           # 변동성·max drawdown
  - latest_fundamentals + recent_financials  # PER/PBR + 어닝 임박 추정
  - 현재 사이클의 다른 voter들(graham, dow, shiller, keynes) 출력 — Q1 합산 후 의심 대상으로 활용

Step 1. Check 1 — 비대칭 측정 (asymmetry)
  vol_252 = stdev(close 252일 일일 수익률) × √252  # annualised
  max_dd = (low_252 - close_today) / close_today    # 음수
  upside_potential = +vol_252                          # 1σ 상승 가능성
  downside_risk   = max(abs(max_dd), vol_252)          # 보수적: 더 큰 쪽
  ratio = upside_potential / max(0.001, downside_risk)

  asymmetry_score:
    ratio ≥ 3.0   → +1.0
    ratio ≥ 1.5   → +0.5
    ratio < 0.5   → -1.0
    ratio < 1.0   → -0.5
    else          →  0

Step 2. Check 2 — 데이터 회의 (M4: 자리표시자)
  accuracy_lookup = None
  data_skepticism_score = 0
  ※ M5+에서 누적 정확도 도입 시 활성화

Step 3. Check 3 — Unknown unknowns (어닝 임박만)
  earnings_proximity = days(today - latest period_end) % 91   # 분기 91일 가정
  imminent = (earnings_proximity < 7) or (earnings_proximity > 84)
  unknowns = [{"type":"earnings","time_proximity":"imminent"}] if imminent else []
  unknowns_score = -0.3 × len(unknowns)

Step 4. risk_score 합산
  raw = asymmetry_score + data_skepticism_score + unknowns_score
  risk_score = clamp(raw, -2.0, +2.0)

Step 5. severity 산출
  worst_dd = abs(max_dd)
  if worst_dd ≥ 0.40 and vol_252 ≥ 0.40:    severity = 5
  elif worst_dd ≥ 0.25 and vol_252 ≥ 0.30:  severity = 4
  elif worst_dd ≥ 0.15:                      severity = 3
  elif worst_dd ≥ 0.08:                      severity = 2
  else:                                       severity = 1

  # imminent earnings는 severity를 한 단계 끌어올림 (cap at 5)
  if imminent and severity < 5:
      severity += 1

Step 6. raw_payload에 4-체크 결과 + LLM 시나리오 narrative 저장.
Step 7. narrative: "변동성 X%, 최대낙폭 Y% — 비대칭 비율 Z. 어닝 D-N. 시나리오: ..."
```

---

## 3. T2 Soros M4 확장

기존 `synthesize_m3` (4 voters) 보존. 새 메서드:

```python
def synthesize_m4(
    ticker, cycle_at,
    *, voters: dict[AgentName, AgentOutput],   # graham, dow, shiller, keynes, taleb
    user_id: UUID | None = None,
    inputs: SorosInputsM3 | None = None,
) -> SynthesisResult
```

알고리즘:
- `M4_VOTERS = ("graham", "dow", "shiller", "keynes", "taleb")`
- Q1: `voter_shares_for(weights, present)` — 5명 정규화. taleb 기본 0.13.
- Q2: priced-in 동일.
- **Q3 (신규 활성화)**: `apply_taleb_constraint(baseline_grade, taleb.severity)`
  - severity 4 → 한 단계 하향, `taleb_override=False`(자동), `weights_snapshot.taleb_constraint_applied=True`
  - severity 5 → BUY/STRONG_BUY → HOLD 강제
  - severity ≤ 3 또는 taleb 부재 → 변동 없음
- `final_signal.taleb_severity` 채움. `taleb_override`는 사용자 수동 무시 시에만 True (M4 자동 발동은 override 아님).

---

## 4. T3 cycle orchestrator → `run_m4_cycle.py`

`run_m3_cycle.py`와 거의 동일하되:
- `M4_CHARACTER_ORDER`에 `("taleb", Taleb)` 추가
- `soros.synthesize_m4(...)` 호출
- 모든 InsufficientData 처리 패턴 동일 (per-character isolation)

`run_m3_cycle.py`는 보존 — 다음 마일스톤에서 deprecate.

---

## 5. T4 검증

- 단위 테스트:
  - Taleb: asymmetry 3구간(좋음/중립/나쁨), severity 5단계, 어닝 임박 booster
  - Soros M4: 5-voter 가중치 정규화, severity 4 → 한 단계 하향, severity 5 → STRONG_BUY → HOLD
- 통합 테스트 (`tests/agents/integration/test_m4_taleb_constraint.py`):
  - 시나리오 F: G+D+S+K 모두 강세 + Taleb severity 4 → STRONG_BUY → BUY (한 단계 하향)
  - 시나리오 G: 강세 + severity 5 → HOLD (강제)
  - 시나리오 H: 약세 (CAUTION) + severity 4 → RISK (CAUTION의 다음)

---

## 6. T5 GitHub Actions

`.github/workflows/agents-cycle.yml`에서 호출 모듈을 `agents.cycle.run_m4_cycle`로 한 줄 교체. 기존 cron 시각(22/03/07 UTC) 유지.

---

## 7. 위험 + 진입 조건

- **위험**:
  - 거짓 경고 비율: 단순 변동성 임계값으로 severity 4를 발행하면 변동성 큰 종목(에코프로 등)에 매일 경고 발생 → 임계값 튜닝 필요. 첫 주는 모니터링만.
  - LLM 시나리오의 사실 일관성: 4-체크 raw_payload가 facts block에 들어가므로 환각 가능성은 낮지만 여전히 sanitizer 적용 필수.
  - Q3 자동 제약 과작동: severity 5가 너무 자주 발행되면 모든 종목이 HOLD에 갇힘 → cycle 후 분포 점검.

- **M5 진입 조건**:
  - [ ] 5명 모두 정상 분석 (50종목 × 5 = 250 outputs/cycle)
  - [ ] severity 4+ 발행 시 자동 제약 1회 이상 작동 확인
  - [ ] 거짓 경고 비율 < 50% (1주 운영 후 회고)
  - [ ] Soros narrative에 Taleb 우려 인용 1회 이상

→ 통과 시 **M5 (Simons + PC 워커)** 진입.
