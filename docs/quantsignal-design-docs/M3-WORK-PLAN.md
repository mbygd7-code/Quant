# 🟧 M3 — Shiller + Keynes 작업 계획서

> **목표**: 시장 사이클(Shiller) + 매크로 영향(Keynes) 두 캐릭터 추가, Soros가 4명 종합.
> **선결 조건**: M2 머지·배포 완료, 첫 cron 실행으로 M2 시그널이 생성됨.
> **원칙**: M1·M2와 동일 — Strangler Fig, 신규 파일만.

---

## 0. M3 단순화 결정 (정의서 ↔ 구현 차이)

캐릭터 정의서들은 PE10·자체 공포지수·내러티브 추적 같은 무거운 데이터 파이프라인을 가정. M2와 동일하게, **이미 적재된 데이터에서 만들 수 있는 가장 정직한 근사**로 시작:

| 정의서 항목 | M3 구현 |
|---|---|
| **Shiller** PE10 (10년 CPI 조정 PER) | 워치리스트 PER 분포의 현재 위치 (252일 분포 percentile) |
| **Shiller** 7-요소 공포지수 | 5-요소 proxy: 모멘텀(close vs MA200), 외인 5일 추세, 변동성(20일 σ), 거래량 이상, KOSPI 신고가/신저가 |
| **Shiller** 내러티브 추적 | M3 미구현 — 정의서에 있는 `narrative_tracking` 테이블은 M4+에서 LLM 별도 cron으로 구축 |
| **Keynes** 7개 매크로 변수 | M3는 5개 (USDKRW, ^TNX, ^VIX, DXY, WTI) — 이미 `kr_macro_betas`에 적재됨 |
| **Keynes** 섹터 민감도 매트릭스 | `kr_sector_betas` (등록된 ETF 베타) + `kr_macro_betas` 직접 사용 |
| **Keynes** 시차 분석 (즉각/단기/중기) | M3 미구현 — 5일 누적 변동만 사용 |
| **거품 경고** (`bubble_alerts` 테이블) | M3 미구현 — Shiller score 임계값을 Soros가 narrative에 반영하는 형태로 대체 |

이 선택의 결과: M3 첫 사이클은 **5명이 아닌 5명의 M2 한정 점수**로 작동 — 무리하게 데이터를 만들지 않고, 다음 마일스톤에서 점진 보강.

---

## 1. 작업 묶음 (T1~T6)

| Task | 항목 | 예상 |
|:---:|---|---:|
| **T1** | `agents/characters/_data.py` 확장 — 매크로/섹터 베타 + global_market 지수 페치 | 1.5h |
| **T2** | Shiller — 시장 regime + 워치리스트 PER 분포 + 공포-탐욕 proxy → 점수 + LLM 코멘트 | 4h |
| **T3** | Keynes — 매크로 5요소 × β → 종목별 expected return → 점수 + LLM 코멘트 | 3h |
| **T4** | Soros M3 — `synthesize_m3` 메서드 추가, 4명 가중치 (graham:dow:shiller:keynes = 0.30:0.30:0.20:0.20 임시) | 2h |
| **T5** | Cycle orchestrator → `agents/cycle/run_m3_cycle.py` 신규, M2 cycle은 보존 | 1.5h |
| **T6** | `.github/workflows/agents-cycle.yml` 업데이트해 M3 runner 호출 | 0.5h |

**총 예상**: ~12.5h. 주말 + 평일 저녁이면 약 1주.

---

## 2. T2 Shiller 알고리즘 (M3 단순화)

```
Step 1. 시장 regime score (one per cycle, ticker=null):
  inputs: KOSPI(^KS11) 200일 close, USDKRW 20일, ^VIX 20일,
          watchlist 50종목 PER 평균/percentile

  components (각 0..100, 50=neutral):
    1. momentum    : KOSPI close vs MA200, 200일 분포에서 percentile
    2. volatility  : ^VIX 20일 평균 → 12 이하=greed (100), 30 이상=fear (0)
    3. valuation   : 워치리스트 평균 forward_pe / 5년 평균 → percentile
    4. foreign     : 외인 5일 누적 net_buy 부호 + 강도
    5. breadth     : 워치리스트 종목 중 close > MA60 비율

  fear_greed_index = mean(components)
  regime stage:
    0..20    "극단적 공포 (Capitulation)"      score +2.0
    20..40   "회복 (Recovery)"                  score +1.0
    40..60   "정상 (Normal)"                    score 0
    60..80   "과열 (Greed)"                     score -1.0
    80..100  "극단적 탐욕 (Mania)"             score -2.0

Step 2. per-ticker 점수:
  ticker_pe = 현재 forward_pe
  ticker_percentile = ticker_pe / sector_median_pe → percentile
  modifier = 0 (neutral PE) / +0.3 (저 PE) / -0.3 (고 PE)

  per_ticker_score = clamp(market_score × 0.7 + modifier, -2, +2)
  (시장 regime이 70%, 종목 본인 PER 위치가 30% 비중)

Step 3. raw_payload에 components + regime 저장.
Step 4. narrative: "시장은 X 단계입니다. 이 종목은 워치리스트 평균 대비 ..."
```

---

## 3. T3 Keynes 알고리즘 (M3 단순화)

```
Step 1. 매크로 5요소 최근 5일 누적 변동 (percent units):
  for factor in ["USDKRW", "^TNX", "^VIX", "DXY", "WTI"]:
    delta_5d[factor] = (close[today] - close[5d ago]) / close[5d ago] × 100

Step 2. ticker × factor β 매트릭스 로드 (kr_macro_betas):
  beta[factor] = row.beta if exists else 0

Step 3. expected_return:
  expected = sum(beta[f] × delta_5d[f] for f in 5 factors)
  단, beta가 0인 factor는 기여 없음

Step 4. score 환산:
  score = clamp(expected × 0.5, -2, +2)
   - expected +4% (강한 매크로 순풍) → score +2 (cap)
   - expected -4% (강한 매크로 역풍) → score -2 (cap)
   - expected ±1% → score ±0.5

Step 5. raw_payload에 5요소별 (delta, beta, contribution) 저장.
Step 6. narrative: "USDKRW가 +1.2% 움직였고 이 종목 베타 -2.1로
        -2.5% 역풍이 예상됩니다. 다만 ^TNX 안정으로 보완..."
```

---

## 4. T4 Soros M3 확장

기존 `synthesize` (M2: graham + dow) 보존. 새 메서드:

```python
def synthesize_m3(
    ticker, cycle_at,
    *, voters: dict[AgentName, AgentOutput],
    user_id: UUID | None = None,
    inputs: SorosInputs | None = None,
) -> SynthesisResult:
    """voters 딕셔너리: {'graham': out, 'dow': out, 'shiller': out, 'keynes': out}"""
```

내부 구조:
- `m3_voter_shares(weights)` — 4명만 정규화. graham 0.30 + dow 0.30 + shiller 0.20 + keynes 0.20 = 1.0
- `weighted_q1_score_m3(scores, shares)` — 일반화된 가중 합산 (None 제외)
- Q2 priced-in / Q3 Taleb null / signal mapping → 기존과 동일

---

## 5. T5 cycle orchestrator → `run_m3_cycle.py`

```python
def run_cycle(...):
    for ticker in tickers:
        graham_out = graham.analyze(ticker, cycle_at)
        dow_out = dow.analyze(ticker, cycle_at)
        shiller_out = shiller.analyze(ticker, cycle_at)
        keynes_out = keynes.analyze(ticker, cycle_at)

        # 4 inserts
        graham_full, dow_full, shiller_full, keynes_full = persist_each
        synth = soros.synthesize_m3(
            ticker, cycle_at,
            voters={
                'graham': graham_full, 'dow': dow_full,
                'shiller': shiller_full, 'keynes': keynes_full,
            },
        )
        ...
```

`run_m2_cycle.py`는 보존 — M3 검증되면 다음 마일스톤에서 deprecate.

---

## 6. 검증 + 위험

- 단위 테스트:
  - Shiller: 5개 시장 regime 단계 분류, ticker score 가중 결합
  - Keynes: 매크로 누적 변동 기여도 합산, 베타 누락 시 0 처리
  - Soros M3: 4명 가중치 정규화, 빠진 voter 시 분배 재계산
- 회귀: 기존 M2 cycle 테스트 + 모든 legacy 테스트
- 위험:
  - **데이터 부족**: `kr_macro_betas` / `kr_sector_betas` 적재된 종목만 정확. 빠진 종목은 score 0
  - **252일 분포 부족**: PE 분포·KOSPI percentile 계산이 신규 상장에서 부정확 → InsufficientDataError로 skip
  - **LLM 비용**: 4명으로 늘어나면 호출 ×2 — prompt caching이 필수

---

## 7. M3 진입 조건 (M4 시작 전)

- [ ] 4명 모두 정상 분석 (50종목 × 4 = 200 agent_outputs/cycle)
- [ ] Shiller가 시장 단계 진단 1회 이상 (예: "정상" → "과열")
- [ ] Keynes가 매크로 알림 1회 이상 (USDKRW ±2% 이상 변동 시)
- [ ] Soros narrative가 4명 의견을 모두 인용
- [ ] 1주 운영 다운 0회

→ 통과 시 **M4 (Taleb)** 진입.
