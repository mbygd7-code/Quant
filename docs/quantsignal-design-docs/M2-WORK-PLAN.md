# 🟦 M2 — Soros + Graham + Dow 작업 계획서

> **마일스톤**: M2 (첫 견제축)
> **목표**: Graham(가치) + Dow(추세) 두 캐릭터의 분석을 Soros가 종합해 첫 시그널을 생성. Taleb·Simons는 M4·M5에서 합류.
> **선결 조건**: M1 완료 (`feature/quantsignal-design` → main 머지됨, 22개 마이그레이션 적용, agents/ 패키지 + apps/web/lib/agents/ 모두 활성).
> **원칙**: M1과 동일 — Strangler Fig, 신규 파일만, 기존 파이프라인 미수정.

---

## 0. 설계 ↔ 구현 매핑 (캐릭터 정의서 → M1 스키마)

캐릭터 정의서들은 캐릭터별 별도 테이블(`graham_assessments`, `dow_assessments`, ...)을 가정했지만 M1에서는 단일 `agent_outputs` + JSONB `raw_payload`로 통합했다. M2 구현은 이 단일 테이블에 맞춘다:

| 정의서 | M1 매핑 |
|---|---|
| `graham_assessments` | `agent_outputs WHERE agent_name='graham'` + raw_payload jsonb |
| `intrinsic_values`, `safety_margin_history` | raw_payload 내부 필드 |
| `dow_assessments`, `trend_classifications`, `support_resistance_levels` | `agent_outputs WHERE agent_name='dow'` + raw_payload |
| `final_signals` | M1 마이그레이션 19 그대로 사용 |
| `daily_briefings` | M1 그대로 |

**추가 마이그레이션 필요 없음** — M1 스키마로 충분.

### 시그널 등급 표기 차이 해소

- 정의서 (`character-soros.md`): `BUY / WATCH / HOLD / REDUCE / SELL`
- M1 합의 (마이그레이션 19 + grade.ts/grading.py): `STRONG_BUY / BUY / HOLD / CAUTION / RISK`

M1 표기를 정본으로 채택. 정의서는 다음 디자인 리뷰에서 일괄 갱신.

---

## 1. 데이터 소스 (M2에서 사용 가능 확인됨)

| 캐릭터 | 사용 테이블 | 컬럼 |
|---|---|---|
| Graham | `kr_fundamentals` | forward_pe, trailing_pe, price_to_book, roe, market_cap |
| Graham | `kr_financials` | revenue, op_income, net_income, *_yoy (분기별) |
| Graham | `korea_market` | close (안전마진 계산용) |
| Dow | `korea_market` | OHLCV, change_rate, foreign_net_buy (200영업일치) |
| Soros | `agent_outputs` | Graham + Dow 출력 |
| Soros | `kr_fundamentals` `korea_market` | Q2 priced-in 평가용 |

**데이터 부족 케이스**:
- DCF 본질가치 = FCF 데이터가 `kr_financials`에 없음 → M2에서는 PER + PBR 두 방법만, DCF는 M3 이후 (필요 시 `kr_financials`에 FCF 컬럼 마이그레이션 추가)

---

## 2. 작업 묶음 (T1~T7)

| Task | 항목 | 예상 | 의존성 |
|:---:|---|---:|---|
| **T1** | 캐릭터 베이스 클래스 + 데이터 페치 헬퍼 (`agents/characters/__init__.py`, `_base.py`, `_data.py`) | 2h | M1 |
| **T2** | Graham 캐릭터 — quality_score + intrinsic value (PER/PBR) + safety margin + LLM narrative | 4h | T1 |
| **T3** | Dow 캐릭터 — 3-축 추세 + 거래량 검증 + LLM narrative | 4h | T1 |
| **T4** | Soros 캐릭터 (M2 제한 버전) — Q1 가중 합산 (Graham+Dow), Q2 priced-in, signal mapping, final_signal write | 3h | T2, T3 |
| **T5** | 분석 사이클 orchestrator — 종목당 Graham → Dow → Soros, 50종목 watchlist, 출력 row 작성 | 2h | T4 |
| **T6** | GitHub Actions cron — 07/12/16 KST × workflow_dispatch | 1.5h | T5 |
| **T7** | UI 노출 — 워치리스트 행에 final_signal 표시, dashboard에 daily briefing 카드 | 3h | T4 |

**총 예상**: ~19.5h. 하루 2-3시간 작업 시 1.5~2주.

---

## 3. T1 — 캐릭터 베이스

### 작업 항목

- [ ] `agents/characters/__init__.py` — re-exports
- [ ] `agents/characters/_base.py` — `Character` ABC:
  ```
  agent_name: AgentName  # class attribute
  def analyze(self, ticker: str, cycle_at: datetime) -> AgentOutputNew
  ```
- [ ] `agents/characters/_data.py` — pure-fetch helpers (DB → domain dataclasses):
  - `latest_fundamentals(ticker) -> KrFundamentalsRow | None`
  - `recent_financials(ticker, n: int = 8) -> list[KrFinancialsRow]` (분기 8개 ≈ 2년)
  - `daily_quotes(ticker, days: int = 252) -> list[KrQuoteRow]`
- [ ] 모든 페치 함수가 빈 결과를 정상으로 처리 (캐릭터가 InsufficientDataError 발생)

### 검증
- 단위 테스트 (mock supabase result) — 정상/빈 결과 분기

---

## 4. T2 — Graham

### 알고리즘 (정의서 §3 단순화)

```
Step 1. quality_score (0~100):
  ROE 5분기 평균 (>15% +25, >10% +15, >5% +5)
  영업이익 YoY 양수 분기 비율 (양수 분기당 +5, 최대 25)
  매출 YoY 추세 (개선/안정/하락 → 20/15/0)
  부채비율 — kr_financials에 없으니 M2 생략 (대신 ROE 안정성 +15)
  경제적 해자 — LLM 정성평가 +0~15

Step 2. intrinsic_value (보수적 = min(method1, method2)):
  방법 1 (PER):    EPS × min(15, 8.5 + 2 × growth_rate)
                   ※ growth_rate = revenue_yoy 평균 (clamp -20%~+30%)
  방법 2 (PBR):    BPS × min(2.0, ROE × 10)

Step 3. safety_margin = (intrinsic_value - close) / intrinsic_value
  > +25%  → score +1.5 (강한 매력)
  +10~25% → score +0.7
  -10~+10% → score 0
  -10~-25% → score -0.7
  < -25%  → score -1.5

Step 4. score 환산 (-2.00 ~ +2.00):
  base = safety_margin_score
  quality boost: quality_score / 100 * 0.5 만큼 곱셈 (좋은 비즈니스 + 저평가 = 강함)
  최종 score: clamp(base × (1 + quality_score/200), -2.00, 2.00)

Step 5. narrative: callClaude with structured output
  system: "너는 Graham이다. 입력 데이터로부터 안전마진 평가를 작성. 매수/매도 단어 금지."
  cache_block: 본질가치 계산 결과 (재계산 안 하도록)
  user: "이 종목 평가해줘: {ticker}, {meta}"
  response_model: GrahamPayload (raw_payload용 구조)
```

### 출력
```python
agent_outputs row:
  agent_name='graham'
  ticker='005930'
  cycle_at=now
  score=Decimal('1.32')           # safety_margin × quality boost
  narrative='삼성전자는 ...'        # Korean, 금지어 sanitized
  raw_payload={
    'quality_score': 78,
    'intrinsic_value_per': 82500,
    'intrinsic_value_pbr': 75200,
    'intrinsic_value_conservative': 75200,
    'current_price': 65800,
    'safety_margin_pct': 12.5,
    'method': 'min(PER, PBR)',
    'data_window': '2024Q1..2025Q4'
  }
  model='claude-sonnet-4-6'
  cost_estimate=0.0034
```

### 검증
- 단위 테스트 (5개 케이스): 강한 매력 / 보통 / 음수 마진 / 데이터 부족 / 안전 데이터 변환
- LLM 호출은 mock (T6 callClaude 패턴 재활용)

---

## 5. T3 — Dow

### 알고리즘 (정의서 §3 단순화)

```
Step 1. 이동평균 계산 (close 시리즈로):
  ma5  = mean(last 5 closes)
  ma20 = mean(last 20)
  ma60 = mean(last 60)
  ma200 = mean(last 200) (없으면 InsufficientDataError)

Step 2. 3-축 추세 평가:
  primary  = +1 if close > ma200 and ma60 > ma200 else (-1 if close < ma200 and ma60 < ma200 else 0)
  secondary = +1 if ma20 > ma60 else (-1 if ma20 < ma60 else 0)
  minor    = +1 if ma5 > ma20 else (-1 if ma5 < ma20 else 0)

Step 3. trend_alignment 분류:
  sum = primary + secondary + minor
  +3 → "강한 상승세 (모든 축 일치)"
  +2 → "약한 상승세 (단기 또는 중기 약함)"
  ...

Step 4. 거래량 검증:
  avg_vol_20 = mean(last 20 volumes)
  recent_vol = mean(last 5 volumes)
  if alignment > 0:
    if recent_vol > avg_vol_20 * 1.1: confirmed = True
  ...

Step 5. score 환산:
  base_score = sum_of_axes × 0.5         # ±1.5
  if not volume_confirmed: base_score *= 0.6
  최종 score: clamp(base_score, -2.00, 2.00)

Step 6. narrative: callClaude
  system: "너는 Dow다. 추세를 시각적·동적으로 묘사."
  user: "{ticker} 추세 분석: ma5={...} alignment={...} volume_confirmed={...}"
  response_model: DowPayload
```

### 출력
```python
raw_payload = {
  'primary_trend': +1,
  'secondary_trend': +1,
  'minor_trend': 0,
  'alignment_label': '약한 상승세 (단기 약함)',
  'ma5': 66200,
  'ma20': 65500,
  'ma60': 63100,
  'ma200': 61500,
  'volume_confirmed': True,
  'recent_volume_ratio': 1.18,
}
```

### 검증
- 5 cases: 모든 축 +/모든 축 -/혼조/거래량 부재/200일 데이터 부족

---

## 6. T4 — Soros (M2 제한 버전)

### 알고리즘

```
Step 1. 사용자 가중치 로드 (T5 — 이미 구현됨):
  weights = repository.get_user_weights(user_id) or DEFAULT_WEIGHTS
  ※ M2에서는 Graham + Dow만 활용 → 두 가중치를 정규화해 합 1.00:
     g_weight = weights['graham'] / (weights['graham'] + weights['dow'])
     d_weight = weights['dow'] / (weights['graham'] + weights['dow'])

Step 2. Q1 가중 합산:
  graham_score = agent_outputs.score where agent_name='graham', ticker=T, cycle_at=this_cycle
  dow_score = agent_outputs.score where agent_name='dow', ticker=T, cycle_at=this_cycle
  weighted = g_weight * graham_score + d_weight * dow_score   # ±2

Step 3. Q2 priced-in (LLM 1회):
  inputs: 최근 20일 가격 모멘텀, 거래량 이상, 뉴스 빈도(M2는 ai_scores에서 가져옴)
  output: priced_in ∈ [0, 1]
  if priced_in > 0.7: weighted *= 0.5   # 신호 약화

Step 4. Q3 Taleb 자동 제약:
  M2 단계에서는 Taleb 출력 없음 → 그대로 통과 (taleb_severity=null, taleb_override=false)

Step 5. 시그널 매핑 (grade.ts/grading.py 재사용):
  signal_grade = score_to_signal_grade(weighted)

Step 6. final_signal write:
  insert into final_signals (ticker, cycle_at, signal_grade, confidence, weighted_score,
                              weights_snapshot, narrative, taleb_severity=null, ...)
  ※ confidence = abs(weighted) / 2.0 (점수 절댓값을 0~1로)

Step 7. signal_change_event:
  비교: latest_final_signal(ticker) vs new
  if grade changed: insert signal_change_events (from_grade, to_grade, reason='agent_consensus_shift')

Step 8. narrative: callClaude
  cache_block: Graham raw_payload + Dow raw_payload (둘 다 캐시 — 길고 안 변함)
  user: "이 종목 결론을 두 의견을 인용하며 작성"
  response_model: SorosNarrativePayload
```

### 검증
- 통합 테스트 (mock both Graham + Dow outputs): 다양한 score 조합 → 올바른 grade 매핑
- signal_change_events 트리거 확인 (이전 grade 다른 경우)

---

## 7. T5 — 사이클 orchestrator

### 작업

- [ ] `agents/cycle/__init__.py`
- [ ] `agents/cycle/run_m2_cycle.py`:
  ```python
  def run_cycle(cycle_at: datetime | None = None) -> CycleReport:
      cycle_at = cycle_at or datetime.now(UTC)
      tickers = [r['ticker'] for r in sb.from_('stocks').select('ticker').eq('is_watchlist', True).execute().data]
      report = CycleReport(cycle_at=cycle_at, tickers=len(tickers))
      
      for ticker in tickers:
          try:
              graham_out = Graham().analyze(ticker, cycle_at)
              repo.insert_agent_output(graham_out)
              dow_out = Dow().analyze(ticker, cycle_at)
              repo.insert_agent_output(dow_out)
              soros_signal = Soros().synthesize(ticker, cycle_at, graham_out, dow_out)
              repo.insert_final_signal(soros_signal)
              report.success += 1
          except InsufficientDataError as exc:
              report.skipped += 1
          except Exception as exc:
              report.errors.append((ticker, str(exc)))
      
      return report
  ```
- [ ] CLI 진입: `python -m agents.cycle.run_m2_cycle [--ticker T1,T2] [--dry-run]`

### 검증
- Dry-run 모드 (DB write 없이 분석만 console에 인쇄)
- 운영 5종목으로 1회 실행 후 agent_outputs + final_signals 검증

---

## 8. T6 — GitHub Actions cron

### 작업

- [ ] `.github/workflows/agents-cycle.yml`:
  ```yaml
  on:
    schedule:
      - cron: '0 22 * * *'   # 07:00 KST = 22:00 UTC 전날
      - cron: '0 3 * * *'    # 12:00 KST = 03:00 UTC 당일
      - cron: '0 7 * * *'    # 16:00 KST = 07:00 UTC 당일
    workflow_dispatch:
      inputs:
        tickers:
          description: 'Comma-separated tickers (empty = all watchlist)'
  
  jobs:
    cycle:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with: { python-version: '3.11', cache: pip, cache-dependency-path: pyproject.toml }
        - run: pip install -e .
        - run: python -m agents.cycle.run_m2_cycle ${{ inputs.tickers && format('--tickers {0}', inputs.tickers) || '' }}
          env:
            SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
            SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
            ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  ```
- [ ] CLAUDE.md §C: "동일 (종목, 일자) 점수는 캐시 — 재호출 금지"  
   M2 단계에선 cycle_at으로 unique이므로 같은 분석 사이클 재실행은 자연스럽게 새 row. 일자 단위 중복 방지는 M3에서 RPC로 추가.

### 검증
- 첫 실행 수동 트리거 (workflow_dispatch with `--tickers 005930`)
- agent_outputs 1행 + final_signals 1행 생성 확인
- LLM 비용 < $0.05 per ticker 확인

---

## 9. T7 — UI 노출

### 작업

- [ ] `apps/web/lib/queries/final-signals.ts` — 워치리스트 행에 결합할 헬퍼
- [ ] `apps/web/components/watchlist/watchlist-table.tsx` (기존 파일 — 신호 컬럼만 추가)
- [ ] `apps/web/components/dashboard/agent-briefing-card.tsx` (신규) — daily_briefings의 최신 row 표시
- [ ] `/dashboard/page.tsx` (기존 — 카드 추가, 기존 컨텐츠 보존)

**Strangler Fig 준수**: 기존 dashboard.tsx 파일은 컴포넌트 추가 형태로만 수정. 기존 카드 보존.

### 검증
- 워치리스트 페이지에 50종목 신호 컬럼 표시
- 대시보드에 일일 브리프 카드 노출
- 시그널 변경 시 행 색깔 변경 (선택 — M2 후속)

---

## 10. M2 완성 기준 (`system-implementation-roadmap.md` §M2)

- [ ] Graham + Dow + Soros가 매일 3회 정상 분석 (50종목 × 3 사이클 = 150 row/day)
- [ ] Soros가 final_signals 생성 + grade mapping 정확 (단위 테스트 통과)
- [ ] Graham vs Dow 충돌 사례 1건 이상 관찰 (cycle 후 비교 쿼리)
- [ ] 사용자가 시그널 변경 알림 받음 (signal_change_events row + 텔레그램 또는 웹 토스트)
- [ ] 1주일 연속 운영 (다운 0회) — 본격 정착 후 측정
- [ ] LLM 비용 모니터링 (M1-T10 대시보드 활용) — 월 $30 이하 목표

---

## 11. 위험 요소

| 위험 | 완화 |
|---|---|
| LLM 비용 폭증 (50종목 × 3 cycle × 3 agent = 450 호출/일) | callClaude prompt 캐싱으로 system+context 95% 절감, M1-T10 대시보드 일일 모니터 |
| Graham 본질가치 비현실적 (PER 공식 한국 시장 부적합) | M2 첫 1주 결과를 시각가의 ±50% 범위 내인지 검증, 벗어나면 공식 보수적 조정 |
| Dow 추세 진단 빈번 변경 (잡음) | 추세 단계 변경 시 1일 cooldown (M3 검토) |
| 200영업일 데이터 부족 (신규 상장 또는 ingestion 짧음) | InsufficientDataError → 해당 종목만 skip, 사이클 전체는 계속 |
| 동일 사이클 중복 실행 (cron + 수동 트리거 동시) | unique constraint `(ticker, cycle_at)` on final_signals 이미 있음 (M1-T1) — 충돌 시 두 번째 실패 |

---

## 12. 다음 마일스톤 진입 조건 (M3)

- M2 완성 기준 모두 통과
- 견제 발동 사례 1건 이상에서 Soros narrative가 두 의견을 모두 인용
- 베이영님 *"이 시스템 쓸 만하다"* 평가
