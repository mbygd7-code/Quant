# 🟥 M5 — Simons (정량 분석가) 작업 계획서

> **목표**: 6번째 voter 추가 — sklearn GBM 기반 종목별 5등급 예측. 6명이 Soros 종합.
> **선결 조건**:
> - M4 운영 1주 안정 (cron × 4 × 7일 = ~28회 실행, 다운 0회)
> - `agent_outputs`에 voter 점수 ≥ 1,000 rows 누적 (Simons 학습 데이터)
> - Anthropic spend cap 적용 + 일일 비용 < $5 검증
> - migrate workflow 정상화 (`SUPABASE_DB_PASSWORD` 디버그 완료)
> **원칙**: M2·M3·M4와 동일 — Strangler Fig, 신규 파일만, 정의서보다 미니멀.

---

## 0. M5 단순화 결정 (정의서 ↔ 구현 차이)

`character-simons.md`는 **PC 워커 + 클라우드 이중 거주 + 포트폴리오 최적화**를 가정. roadmap §M5도 "가장 위험"으로 분류. 이번 M5는 **클라우드 단독 + 종목별 점수만** 으로 단순화.

| 정의서 항목 | M5 구현 |
|---|---|
| **PC 워커 인프라** | M5 미구현 — GitHub Actions runner에서 학습/추론 (5분 timeout 충분) |
| **pc_worker_heartbeat 테이블** | M5 미구현 — 항상 fresh (Actions에서 매 cron 추론) |
| **24h/7d 신선도 디그라데이션** | M5 미구현 — fresh 가정 |
| **포트폴리오 최적화 (Markowitz)** | M5 미구현 — M6+에서 |
| **portfolio_simulations 테이블** | M5 미구현 |
| **simons_assessments 별도 테이블** | M5는 `agent_outputs.raw_payload`로 통합 (다른 캐릭터와 동일 패턴) |
| **GBM 모델** | sklearn `GradientBoostingClassifier` (기존 `signals/gbm.py` 재사용 가능) |
| **5등급 예측** | 기존 grade enum 재사용 |
| **신뢰도 (confidence)** | `predict_proba` 의 max 사용 |
| **피처 엔지니어링** | 기존 `signals/features.py` 또는 4 voter 점수 + 가격 모멘텀 |

핵심 단순화: **PC 워커 분리는 M7+에서**, 이번엔 GBM이 클라우드에서 직접 도는 형태. 데이터 보안·비용·복잡도 모두 줄어듦.

---

## 1. 작업 묶음 (T1~T6)

| Task | 항목 | 예상 |
|:---:|---|---:|
| **T1** | `agents/characters/simons.py` — 추론 전용 (학습된 모델 로드 + 예측) | 3h |
| **T2** | `agents/training/train_simons.py` — `agent_outputs` + `korea_market`로 학습 데이터 만들고 GBM 학습 | 4h |
| **T3** | `.github/workflows/simons-train.yml` — 주 1회 자동 재학습 (월요일 새벽) | 1h |
| **T4** | Soros — `synthesize_m5` 메서드 (6-voter), Q3 Taleb 자동 제약 유지 | 2h |
| **T5** | `agents/cycle/run_m5_cycle.py` 신규, M4 cycle 보존 | 1h |
| **T6** | 단위·통합 테스트 + workflow swap | 2h |

**총 예상**: ~13h. 1주 작업 (재학습 결과 검증 시간 별도).

---

## 2. T1 Simons 추론 알고리즘 (M5 단순화)

```
입력 데이터 (cycle_at 기준):
  - 기존 voter outputs (graham, dow, shiller, keynes, taleb)의 score
  - korea_market 최근 60일 (가격 모멘텀)
  - kr_macro_betas (매크로 노출도)

피처 엔지니어링 (~10 피처):
  feat[0..4] = voter scores (graham, dow, shiller, keynes, taleb)
  feat[5]    = 5일 가격 모멘텀
  feat[6]    = 20일 가격 모멘텀
  feat[7]    = 60일 가격 모멘텀
  feat[8]    = 거래량 비율 (현재 / 20일 평균)
  feat[9]    = 매크로 베타 합산 (이미 Keynes에 있지만 raw 값 별도)

추론:
  model = joblib.load("simons_gbm.pkl")  # T3 워크플로우가 매주 갱신
  proba = model.predict_proba([feat])[0]  # 5-class
  best_class = argmax(proba)
  confidence = max(proba)

5등급 → 점수 매핑:
  STRONG_BUY → +2.0
  BUY        → +1.0
  HOLD       →  0.0
  CAUTION    → -1.0
  RISK       → -2.0

신뢰도 보정:
  if confidence < 0.5: score *= 0.5  # 신호 약화
  elif confidence > 0.8: score *= 1.0
  else: score *= 0.7  # 중간

raw_payload:
  {
    "predicted_class": "BUY",
    "class_probabilities": [0.05, 0.65, 0.20, 0.08, 0.02],
    "confidence": 0.65,
    "feature_values": [...],
    "model_version": "2026-05-15"
  }

narrative: LLM이 raw_payload 보고 "GBM은 65% 확률로 BUY를 예측합니다.
            특히 Dow score (+1.5)와 거래량 비율 (1.8)이 결정적이었습니다." 스타일
```

**모델 파일 저장 위치**: Supabase Storage `simons-models/` 버킷 또는 GitHub Release artifact. 후자가 단순.

---

## 3. T2 학습 스크립트

```
입력:
  agent_outputs (M4 운영 1주 후 ≥1,000 rows)
  korea_market (forward return 계산용)

학습 데이터 셋:
  for each (ticker, cycle_at) in agent_outputs:
    features = build_features(ticker, cycle_at)  # T1과 동일 함수
    label    = forward_return_class(ticker, cycle_at, horizon=20)
              # < -10%       → RISK
              # < -3%        → CAUTION
              # -3 ~ +3%     → HOLD
              # +3 ~ +10%    → BUY
              # > +10%       → STRONG_BUY
    yield (features, label)

검증:
  train/test split: 시간 기준 (최근 20% test)
  지표: accuracy + per-class precision/recall
  acceptance: overall accuracy > 0.40 (5-class baseline 0.20 대비)

저장:
  joblib.dump(model, "simons_gbm.pkl")
  GitHub Release로 push (시점 + 정확도 기록)

CLI:
  python -m agents.training.train_simons \
    --start 2026-04-15 --end 2026-05-12 \
    --output simons_gbm_v1.pkl --report report.md
```

---

## 4. T3 주간 재학습 워크플로우

`.github/workflows/simons-train.yml`:
- cron: `0 16 * * 0` (일요일 01:00 KST, 월요일 cron 시작 전)
- 작업: train_simons → 결과를 GitHub Release artifact로 업로드
- M5 cycle은 매번 최신 release를 다운로드해 사용

---

## 5. T4 Soros M5 확장

기존 `synthesize_m4` 보존. 새 메서드:

```python
M5_VOTERS = ("simons", "graham", "dow", "shiller", "keynes", "taleb")

def synthesize_m5(
    ticker, cycle_at,
    voters: dict[AgentName, AgentOutput],   # 6명
    *, user_id, inputs
) -> SynthesisResult:
    # Q1: 6-voter 가중합
    # Q2: priced-in 동일
    # Q3: Taleb 자동 제약 유지
    ...
```

기본 가중치 (DEFAULT_WEIGHTS):
- simons: 0.20 (정량 신호 가장 신뢰)
- graham: 0.18
- dow: 0.18
- keynes: 0.18
- shiller: 0.13
- taleb: 0.13 (최소 10% 강제)

---

## 6. T5 cycle orchestrator

`run_m5_cycle.py`:
- M4 cycle와 동일 구조
- M5_CHARACTER_ORDER에 ("simons", Simons) 추가
- run_m4_cycle.py의 tier filter + change-detect 그대로 재사용

---

## 7. 검증 + 위험

### 단위 테스트
- Simons: 피처 빌더 + 5-class → score 매핑 + 신뢰도 보정
- Soros M5: 6-voter 가중치 정규화

### 통합 테스트
- 시나리오 L: GBM이 BUY 예측 + 다른 voter들 동의 → STRONG_BUY
- 시나리오 M: GBM BUY + Taleb sev 4 → 자동 제약으로 HOLD
- 시나리오 N: GBM 확신 낮음 (confidence < 0.5) → score 절반

### 위험
- **데이터 부족**: 1주 운영으로 1,500 rows. 5-class 학습엔 빠듯. 만약 정확도가 baseline 미만이면 → 2주 더 운영 후 재학습
- **Class imbalance**: HOLD가 60% 이상이면 모델이 항상 HOLD 예측. SMOTE 또는 class_weight='balanced' 적용
- **Overfitting**: train/test 시간 기준 split 필수. 무작위 split은 lookahead bias
- **모델 파일 거버넌스**: 어떤 commit에서 학습됐는지 metadata 필수. raw_payload에 model_version 기록

---

## 8. M6 진입 조건

- [ ] Simons 정확도 ≥ 0.40 (5-class)
- [ ] 6명 voter cycle 1주 안정 (50종목 × 6 = 300 outputs/cycle)
- [ ] Soros narrative가 6명 의견 모두 인용
- [ ] Shiller ↔ Simons 견제 1회 이상 관찰 (Shiller "greed" + Simons "BUY" 충돌)
- [ ] Taleb이 Simons 의심 1회 이상 (Check 2 활성화 필요 — M5 placeholder 단계)

→ 통과 시 **M6 (UI 기본 + 대화)** 진입.

---

## 9. 미해결 (M5 후 다음 라운드)

- [ ] PC 워커 분리 (정의서 §1.3) — 클라우드 학습이 시간/비용 부담될 때
- [ ] 포트폴리오 최적화 (Markowitz) — M6+
- [ ] 시간 신선도 디그라데이션 (24h/7d)
- [ ] Taleb의 Simons 정확도 검증 (Check 2 활성화) — 1개월 운영 후
- [ ] `signals/gbm.py` 통합 — 레거시 GBM 코드와 합치기 vs 새로 작성
