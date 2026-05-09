# 🌊 데이터 플로우 다이어그램

> **QuantSignal 시스템 통합 정의서 v1.0**
> 전체 시스템의 데이터 흐름을 Mermaid로 시각화.
> 7단계 백엔드 파이프라인 + 8명 캐릭터 + Supabase + PC 워커 + 사용자 UI를 모두 포함.

---

## 0. 설계 원칙

1. **단일 진실 공급원은 Supabase** — 모든 컴포넌트가 Supabase를 통해 통신
2. **PC 워커는 비동기** — 클라우드는 PC를 기다리지 않음
3. **시간 축이 다른 데이터는 분리** — 매일/매주/매월/실시간 데이터가 섞이지 않음
4. **모든 데이터는 추적 가능** — 어느 컴포넌트가 언제 만들었는지 항상 알 수 있음

---

## 1. 전체 시스템 다이어그램 (Big Picture)

```mermaid
graph TB
    subgraph "외부 데이터 소스"
        FH[Finnhub API]
        DART[DART 공시]
        KRX[pykrx]
        OAI[OpenAI 임베딩]
        ANT[Anthropic Claude]
    end
    
    subgraph "GitHub Actions (가벼운 cron)"
        COL[collectors]
        REF[refinery]
        COG[cognition]
    end
    
    subgraph "PC 워커 (무거운 ML)"
        PC1[Simons GBM 학습]
        PC2[백테스트]
        PC3[포트폴리오 시뮬]
        HB[Heartbeat]
    end
    
    subgraph "Supabase (단일 진실 공급원)"
        DB1[(원시 데이터)]
        DB2[(정제 데이터)]
        DB3[(점수·예측)]
        DB4[(캐릭터 출력)]
        DB5[(최종 시그널)]
        DB6[(사용자 데이터)]
    end
    
    subgraph "클라우드 (캐릭터 8명)"
        CC[Claude API]
        T[Turing]
        SI[Simons]
        G[Graham]
        D[Dow]
        SH[Shiller]
        K[Keynes]
        TA[Taleb]
        SO[Soros]
    end
    
    subgraph "사용자 인터페이스"
        UI1[웹 대시보드]
        UI2[모바일 앱]
        NOT[알림 - 텔레그램·카카오]
    end
    
    FH --> COL
    DART --> COL
    KRX --> COL
    COL --> DB1
    DB1 --> REF
    REF --> DB2
    DB2 --> COG
    OAI --> COG
    COG --> DB3
    
    DB2 --> PC1
    DB3 --> PC2
    PC1 --> DB3
    PC2 --> DB3
    PC3 --> DB3
    PC1 -.-> HB
    HB --> DB6
    
    UI1 --> T
    UI2 --> T
    T --> SI
    T --> G
    T --> D
    T --> SH
    T --> K
    T --> TA
    T --> SO
    
    DB3 --> SI
    DB3 --> G
    DB3 --> D
    DB3 --> SH
    DB3 --> K
    
    SI --> DB4
    G --> DB4
    D --> DB4
    SH --> DB4
    K --> DB4
    
    DB4 --> TA
    TA --> DB4
    
    DB4 --> SO
    SO --> DB5
    
    DB5 --> UI1
    DB5 --> UI2
    DB5 --> NOT
    
    CC -.프롬프트.-> SI
    CC -.프롬프트.-> G
    CC -.프롬프트.-> D
    CC -.프롬프트.-> SH
    CC -.프롬프트.-> K
    CC -.프롬프트.-> TA
    CC -.프롬프트.-> SO
    CC -.프롬프트.-> T
```

---

## 2. 레이어별 세부 다이어그램

시스템을 5개 레이어로 분리해서 각각 세부 흐름을 정의.

### 레이어 1: 수집 (Collection)

```mermaid
graph LR
    subgraph "외부 API"
        FH[Finnhub<br/>가격·뉴스]
        DART[DART<br/>공시]
        KRX[pykrx<br/>한국 가격]
        AV[Alpha Vantage<br/>매크로]
    end
    
    subgraph "GitHub Actions cron<br/>매일 새벽 6시"
        COL_F[collectors/finnhub.py]
        COL_D[collectors/dart.py]
        COL_K[collectors/krx.py]
        COL_M[collectors/macro.py]
    end
    
    subgraph "Supabase 원시 영역"
        T1[(korea_market<br/>가격·거래량)]
        T2[(news<br/>뉴스 원본)]
        T3[(kr_dart_filings<br/>공시 원본)]
        T4[(macro_raw<br/>매크로 변수)]
    end
    
    FH --> COL_F
    DART --> COL_D
    KRX --> COL_K
    AV --> COL_M
    
    COL_F --> T1
    COL_F --> T2
    COL_D --> T3
    COL_K --> T1
    COL_M --> T4
```

**특징**:
- 빈도: 매일 1회 (아침 6시)
- 실행 환경: GitHub Actions
- 멱등성: 같은 날짜 재실행 시 UPSERT로 중복 방지
- 실패 시: heartbeat 누락 → 알림

### 레이어 2: 정제 (Refinement)

```mermaid
graph LR
    subgraph "Supabase 원시"
        R1[(korea_market)]
        R2[(news)]
        R3[(kr_dart_filings)]
        R4[(macro_raw)]
    end
    
    subgraph "GitHub Actions<br/>수집 직후"
        REF1[Pydantic 검증]
        REF2[중복 제거]
        REF3[형식 정규화]
        REF4[결측치 처리]
    end
    
    subgraph "Supabase 정제"
        C1[(kr_fundamentals<br/>재무지표)]
        C2[(kr_dart_financials<br/>구조화된 재무제표)]
        C3[(news_cleaned)]
        C4[(macro_normalized)]
    end
    
    R1 --> REF1
    R2 --> REF1
    R3 --> REF1
    R4 --> REF1
    
    REF1 --> REF2 --> REF3 --> REF4
    
    REF4 --> C1
    REF4 --> C2
    REF4 --> C3
    REF4 --> C4
```

**특징**:
- 빈도: 수집 직후 자동
- 핵심 검증: Pydantic으로 타입·범위 체크
- 실패 데이터: `_quarantine` 테이블로 분리

### 레이어 3: 인지 (Cognition - LLM/임베딩)

```mermaid
graph TB
    subgraph "Supabase 정제"
        IN1[(kr_fundamentals)]
        IN2[(kr_dart_financials)]
        IN3[(news_cleaned)]
        IN4[(macro_normalized)]
    end
    
    subgraph "GitHub Actions<br/>정제 직후"
        SENT[cognition/sentiment.py<br/>뉴스 감성]
        EMB[cognition/embedder.py<br/>벡터 임베딩]
        SCORE[cognition/scorer.py<br/>7요소 점수]
        MAP[cognition/mapper.py<br/>한미 종목 매핑]
        BRIEF[cognition/market_brief.py<br/>일일 시장 브리프]
    end
    
    subgraph "외부"
        OAI_EMB[OpenAI<br/>임베딩 API]
        ANT_LLM[Anthropic<br/>Claude API]
    end
    
    subgraph "Supabase 인지 출력"
        O1[(ai_scores<br/>7요소 종합)]
        O2[(news_with_sentiment)]
        O3[(news_embeddings<br/>pgvector)]
        O4[(us_kr_mapping)]
        O5[(market_briefs<br/>일일 브리프)]
        O6[(sector_betas)]
        O7[(macro_betas)]
    end
    
    IN1 --> SCORE
    IN2 --> SCORE
    IN3 --> SENT
    IN4 --> SCORE
    
    SENT --> ANT_LLM
    ANT_LLM --> SENT
    SENT --> O2
    
    IN3 --> EMB
    EMB --> OAI_EMB
    OAI_EMB --> EMB
    EMB --> O3
    
    SCORE --> O1
    SCORE --> O6
    SCORE --> O7
    
    MAP --> O4
    BRIEF --> ANT_LLM
    ANT_LLM --> BRIEF
    BRIEF --> O5
```

**특징**:
- 외부 API 호출 비용 발생 (OpenAI 임베딩 + Anthropic LLM)
- 캐싱: 같은 뉴스 재임베딩 안 함
- 출력: 점수·임베딩·브리프

### 레이어 4: 분석 (PC 워커 + 캐릭터)

PC 워커와 클라우드 캐릭터의 협력이 가장 복잡한 부분.

```mermaid
graph TB
    subgraph "Supabase 인지 출력"
        IN1[(ai_scores)]
        IN2[(kr_fundamentals)]
        IN3[(sector_betas)]
        IN4[(macro_betas)]
        IN5[(market_briefs)]
        IN6[(news_with_sentiment)]
        IN7[(kr_dart_financials)]
    end
    
    subgraph "PC 워커<br/>매일 아침 7시"
        PC_GBM[GBM 학습/추론]
        PC_BT[백테스트]
        PC_PF[포트폴리오 시뮬]
        PC_HB[Heartbeat 갱신]
    end
    
    subgraph "Supabase PC 출력"
        PC_O1[(score_predictions<br/>5등급 예측)]
        PC_O2[(ml_features)]
        PC_O3[(backtest_results)]
        PC_O4[(portfolio_simulations)]
        PC_O5[(pc_worker_heartbeat)]
    end
    
    subgraph "클라우드 분석가 5명<br/>분석 사이클 1일 3회"
        SI_C[Simons<br/>자연어 보고]
        G_C[Graham]
        D_C[Dow]
        SH_C[Shiller]
        K_C[Keynes]
    end
    
    subgraph "Supabase 캐릭터 출력"
        CO1[(simons_assessments)]
        CO2[(graham_assessments)]
        CO3[(dow_assessments)]
        CO4[(shiller_assessments)]
        CO5[(keynes_assessments)]
    end
    
    subgraph "클라우드 검증자"
        TA_C[Taleb<br/>리스크 검증]
    end
    
    subgraph "Supabase 검증 출력"
        VO1[(risk_assessments)]
        VO2[(risk_alerts)]
    end
    
    subgraph "클라우드 종합자"
        SO_C[Soros<br/>최종 결정]
    end
    
    subgraph "Supabase 최종"
        FO1[(final_signals)]
        FO2[(daily_briefings)]
        FO3[(signal_change_events)]
    end
    
    IN1 --> PC_GBM
    IN2 --> PC_GBM
    IN3 --> PC_GBM
    IN4 --> PC_GBM
    
    PC_GBM --> PC_O1
    PC_GBM --> PC_O2
    PC_BT --> PC_O3
    PC_PF --> PC_O4
    PC_HB --> PC_O5
    
    PC_O1 --> SI_C
    IN1 --> G_C
    IN2 --> G_C
    IN7 --> G_C
    IN1 --> D_C
    IN6 --> SH_C
    IN5 --> SH_C
    IN3 --> K_C
    IN4 --> K_C
    PC_O5 --> SI_C
    
    SI_C --> CO1
    G_C --> CO2
    D_C --> CO3
    SH_C --> CO4
    K_C --> CO5
    
    CO1 --> TA_C
    CO2 --> TA_C
    CO3 --> TA_C
    CO4 --> TA_C
    CO5 --> TA_C
    
    TA_C --> VO1
    TA_C --> VO2
    
    CO1 --> SO_C
    CO2 --> SO_C
    CO3 --> SO_C
    CO4 --> SO_C
    CO5 --> SO_C
    VO1 --> SO_C
    
    SO_C --> FO1
    SO_C --> FO2
    SO_C --> FO3
```

**특징**:
- PC 워커 출력 → 클라우드 캐릭터 입력 (비동기)
- Heartbeat 체크: Simons가 PC 데이터 신선도 평가
- Taleb은 *항상 마지막 분석가*: 다른 5명 출력 후 검증
- Soros는 *모든 출력을 합산*하는 종합자

### 레이어 5: 전달 (Delivery - UI/알림)

```mermaid
graph TB
    subgraph "Supabase 최종"
        F1[(final_signals)]
        F2[(daily_briefings)]
        F3[(signal_change_events)]
        F4[(risk_alerts)]
        F5[(bubble_alerts)]
        F6[(macro_alerts)]
    end
    
    subgraph "Vercel 클라우드"
        API[Next.js API Routes]
        WS[Realtime 구독]
    end
    
    subgraph "사용자 인터페이스"
        WEB[웹 대시보드]
        MOB[모바일 앱]
        CHART[D3.js 차트]
        WL[워치리스트]
        ALERTS[알림 패널]
    end
    
    subgraph "외부 알림 채널"
        TG[Telegram]
        KK[KakaoTalk]
        EMAIL[Email]
    end
    
    subgraph "사용자 액션"
        UQ[질문 입력]
        UC[설정 변경]
        UF[피드백]
    end
    
    F1 --> API
    F2 --> API
    F3 --> API
    F4 --> API
    F5 --> API
    F6 --> API
    
    F3 --> WS
    F4 --> WS
    F5 --> WS
    F6 --> WS
    
    API --> WEB
    API --> MOB
    
    WS --> WEB
    WS --> MOB
    
    WEB --> CHART
    WEB --> WL
    WEB --> ALERTS
    
    F3 --> TG
    F4 --> TG
    F5 --> KK
    
    UQ --> API
    UC --> API
    UF --> API
```

**특징**:
- API 라우트: 사용자 요청 처리
- Realtime: 시그널 변경 즉시 푸시
- 알림: 텔레그램·카카오 동시 발송 가능

---

## 3. 시간 축별 데이터 흐름

같은 시스템도 *언제 데이터가 흐르는지*에 따라 다르게 작동.

### 매일 (Daily Cycle)

```mermaid
gantt
    title 매일 데이터 흐름 타임라인
    dateFormat HH:mm
    axisFormat %H:%M
    
    section 수집·정제
    GitHub Actions 시작     :h1, 06:00, 30m
    collectors 실행         :h2, after h1, 20m
    refinery 실행           :h3, after h2, 15m
    cognition 실행          :h4, after h3, 25m
    
    section PC 워커
    PC heartbeat 시작       :m1, 07:00, 5m
    Simons GBM 추론         :m2, after m1, 30m
    포트폴리오 시뮬         :m3, after m2, 15m
    
    section 분석 사이클 1 - 아침
    분석가 5명 호출         :a1, 07:30, 5m
    Taleb 검증             :a2, after a1, 3m
    Soros 종합             :a3, after a2, 5m
    모닝 브리프 발행       :a4, after a3, 1m
    
    section 분석 사이클 2 - 점심
    분석 사이클 (간이)     :p1, 12:00, 10m
    
    section 분석 사이클 3 - 장마감
    분석 사이클 (간이)     :c1, 16:00, 10m
    
    section 알림 발송
    아침 알림              :n1, 07:35, 5m
    중요 변경 알림         :n2, 09:00, 5m
    장마감 알림            :n3, 16:30, 5m
```

### 매주 (Weekly Cycle)

```mermaid
graph LR
    SUN[일요일 새벽] --> S1[자기 성찰 루프]
    S1 --> S2[8명 모두 자기 회고]
    S2 --> S3[지난주 결정 vs 결과]
    S3 --> S4[패턴 추출]
    S4 --> S5[agent_knowledge 갱신]
    S5 --> MON[월요일 시작 시 반영]
```

### 매월 (Monthly Cycle)

```mermaid
graph LR
    M1[매월 첫 주말] --> M2[Simons 모델 재학습]
    M2 --> M3[새 모델 vs 기존 모델 백테스트]
    M3 --> M4{성능 향상?}
    M4 -->|예| M5[모델 자동 교체]
    M4 -->|아니오| M6[기존 모델 유지]
    M5 --> M7[모델 버전 갱신]
    M6 --> M8[다음 달 재시도]
```

### 매 분기 (Quarterly Cycle)

```mermaid
graph LR
    Q1[분기 끝] --> Q2[섹터 베타 매트릭스 갱신]
    Q2 --> Q3[Keynes 베타 재추정]
    Q3 --> Q4[새 매크로 변수 검토]
    Q4 --> Q5[가중치 추천 갱신 - 사용자별]
```

### 실시간 (Real-time Trigger)

```mermaid
graph TB
    E1[FOMC 발표] --> T1[Keynes 즉시 호출]
    E2[환율 급변동 ±2%] --> T1
    E3[severity 4+ 발생] --> T2[Taleb 알림 즉시 발송]
    E4[추세 전환 감지] --> T3[Dow 알림]
    E5[거품 임계값 돌파] --> T4[Shiller 알림]
    
    T1 --> R[Soros 임시 가중치 조정]
    R --> N[사용자 알림]
    T2 --> N
    T3 --> N
    T4 --> N
```

---

## 4. 사용자 액션이 데이터에 미치는 영향

사용자가 무언가 할 때 데이터가 어떻게 흐르는지 5가지 시나리오.

### 시나리오 A: 사용자가 종목을 워치리스트에 추가

```mermaid
sequenceDiagram
    participant U as 사용자
    participant API as Next.js API
    participant DB as Supabase
    participant PC as PC 워커
    participant SI as Simons
    
    U->>API: SK하이닉스 추가
    API->>DB: user_watchlists INSERT
    DB-->>API: 확인
    API-->>U: 추가됨
    
    Note over DB,PC: 다음 PC 사이클에 자동 반영
    
    PC->>DB: 새 종목 감지
    PC->>PC: GBM 추론 실행
    PC->>DB: score_predictions INSERT
    
    Note over DB,SI: 다음 분석 사이클에 자동 반영
    
    SI->>DB: 예측 읽기
    SI->>DB: simons_assessments INSERT
```

### 시나리오 B: 사용자가 가중치 변경

```mermaid
sequenceDiagram
    participant U as 사용자
    participant API as Next.js API
    participant DB as Supabase
    participant SO as Soros
    
    U->>API: Taleb 0.13 → 0.20
    API->>API: 제약 검증 (5%~40%, Taleb 최소 10%)
    API->>API: 자동 정규화 (합계 1.0)
    API->>DB: user_weight_settings UPDATE
    API->>DB: weight_settings_history INSERT
    DB-->>API: 확인
    API-->>U: 저장됨
    
    Note over DB,SO: 다음 분석 사이클부터 새 가중치 적용
    
    SO->>DB: load_user_weight_settings
    SO->>SO: 새 가중치로 Q1 합산
    SO->>DB: final_signals INSERT
```

### 시나리오 C: 사용자가 질문 ("SK하이닉스 어때?")

```mermaid
sequenceDiagram
    participant U as 사용자
    participant T as Turing
    participant DB as Supabase
    participant SO as Soros
    participant SI as Simons
    participant G as Graham
    participant D as Dow
    participant SH as Shiller
    participant K as Keynes
    participant TA as Taleb
    
    U->>T: SK하이닉스 어때?
    T->>T: 의도 분류: synthesis
    T->>SO: 위임
    
    par 5명 동시 호출
        SO->>SI: 분석 요청
        SI->>DB: score_predictions 읽기
        SI-->>SO: simons_score
    and
        SO->>G: 분석 요청
        G->>DB: kr_fundamentals 읽기
        G-->>SO: graham_score
    and
        SO->>D: 분석 요청
        D->>DB: korea_market 읽기
        D-->>SO: dow_score
    and
        SO->>SH: 분석 요청
        SH->>DB: market_briefs 읽기
        SH-->>SO: shiller_score
    and
        SO->>K: 분석 요청
        K->>DB: sector_betas 읽기
        K-->>SO: keynes_score
    end
    
    SO->>TA: 5명 출력으로 검증
    TA->>DB: agent_outputs 읽기
    TA-->>SO: severity + risk_score
    
    SO->>SO: Q1 + Q2 + Q3 종합
    SO->>DB: final_signals UPSERT
    SO->>DB: daily_briefings INSERT
    SO-->>T: 응답
    T-->>U: narrative + 시그널
```

### 시나리오 D: 사용자가 피드백 (👎)

```mermaid
sequenceDiagram
    participant U as 사용자
    participant API as Next.js API
    participant DB as Supabase
    participant Agent as 해당 캐릭터
    
    U->>API: 시그널에 👎
    API->>DB: agent_feedback INSERT
    
    Note over DB,Agent: 주간 자기 성찰에 반영
    
    Agent->>DB: 매주 일요일 새벽
    Agent->>DB: agent_feedback 읽기
    Agent->>Agent: 패턴 분석
    Agent->>DB: agent_knowledge UPDATE
```

### 시나리오 E: 시장 이벤트 발생 (FOMC 발표)

```mermaid
sequenceDiagram
    participant EV as 외부 이벤트
    participant COL as collectors
    participant DB as Supabase
    participant K as Keynes
    participant SO as Soros
    participant N as 알림
    participant U as 사용자
    
    EV->>COL: FOMC 결과 발표
    COL->>DB: macro_normalized UPDATE
    
    Note over DB,K: 즉시 트리거
    
    DB->>K: 변동 감지 (50bp 이상)
    K->>K: 영향 분석
    K->>DB: keynes_assessments INSERT
    K->>DB: macro_alerts INSERT
    
    DB->>SO: Taleb·Keynes 알림 감지
    SO->>SO: 임시 가중치 상향 (Keynes ×1.5)
    SO->>DB: 영향받는 종목 재분석
    SO->>DB: signal_change_events INSERT
    
    DB->>N: 알림 트리거
    N->>U: 텔레그램 푸시
```

---

## 5. 데이터 보존 정책

| 데이터 종류 | 보존 기간 | 이유 |
|---|---|---|
| 원시 가격 (`korea_market`) | 영구 | 백테스트, 차트 표시 |
| 원시 뉴스 (`news`) | 5년 | 학습 데이터 |
| 원시 공시 (`kr_dart_filings`) | 영구 | 펀더멘털 추적 |
| 캐릭터 출력 (`*_assessments`) | 2년 | 자기 성찰, 강화 학습 |
| 시그널 (`final_signals`) | 영구 | 사용자 결정 추적 |
| 사용자 피드백 (`agent_feedback`) | 영구 | 학습 데이터 |
| 라우팅 로그 (`turing_routing_logs`) | 6개월 | 디스크 절약 |
| 임시 캐시 (`ml_features`) | 7일 | 재계산 가능 |

---

## 6. 장애 대응 흐름

각 컴포넌트 장애 시 시스템 동작.

### PC 워커 장애

```mermaid
graph TB
    F1[PC 워커 비활성] --> C1{Heartbeat 시간 체크}
    C1 -->|< 24시간| OK1[정상 작동, 기존 데이터 사용]
    C1 -->|24-168시간| W1[경고 표시, 점수 -20%]
    C1 -->|> 168시간| W2[Simons 의견 무효, Soros에 알림]
    
    W2 --> N1[사용자에게 알림: PC 다시 켜주세요]
```

### GitHub Actions 장애

```mermaid
graph TB
    F1[cron 실패] --> C1{재시도 횟수}
    C1 -->|< 3회| R1[자동 재시도]
    C1 -->|>= 3회| A1[관리자 알림]
    A1 --> A2[기존 데이터로 시스템 작동 - 신선도 경고]
```

### Anthropic API 장애

```mermaid
graph TB
    F1[Claude API 실패] --> C1{어느 캐릭터?}
    C1 -->|일반 분석가| R1[해당 캐릭터 의견 보류, 다른 5명으로 진행]
    C1 -->|Soros| W1[종합 못함, 기존 시그널 유지]
    C1 -->|Turing| W2[직접 라우팅 UI로 전환]
```

### Supabase 장애

```mermaid
graph TB
    F1[Supabase 다운] --> A1[전체 시스템 일시 중단]
    A1 --> A2[사용자에게 점검 페이지]
    A2 --> A3[복구 후 자동 재개]
```

---

## 7. 데이터 정합성 체크 (매일)

매일 새벽 자동 실행되는 데이터 품질 체크.

```mermaid
graph LR
    CHK1[가격 데이터 누락 체크] --> R1[리포트]
    CHK2[7요소 점수 분포 체크] --> R1
    CHK3[캐릭터 출력 누락 체크] --> R1
    CHK4[시그널 변경 일관성 체크] --> R1
    CHK5[heartbeat 신선도 체크] --> R1
    
    R1 --> DEC{이상 감지?}
    DEC -->|예| ALERT[관리자 알림]
    DEC -->|아니오| OK[정상]
```

---

## 8. 데이터 흐름 디버깅 가이드

*"왜 이 시그널이 나왔지?"* 를 추적하는 표준 절차.

### 디버깅 7단계

```mermaid
graph TB
    Q[왜 이 시그널?] --> S1[1. final_signals 조회]
    S1 --> S2[2. cycle_id로 daily_briefings 조회]
    S2 --> S3[3. Soros의 Q1 합산 확인]
    S3 --> S4[4. 6명 캐릭터 출력 확인]
    S4 --> S5[5. 각 캐릭터의 입력 데이터 확인]
    S5 --> S6[6. 원시 데이터까지 추적]
    S6 --> S7[7. Taleb override 여부 확인]
    
    S7 --> A[근본 원인 발견]
```

### SQL 예시

```sql
-- 1. 최종 시그널
SELECT * FROM final_signals WHERE ticker = 'SK하이닉스' AND created_at::date = '2025-01-15';

-- 2. 그 cycle의 일일 브리프
SELECT * FROM daily_briefings WHERE briefing_date = '2025-01-15';

-- 3. 6명 캐릭터 출력 (cycle_id로)
SELECT * FROM agent_outputs WHERE cycle_id = 'xxx';

-- 4. Taleb 우려 (그 시점)
SELECT * FROM risk_assessments WHERE cycle_id = 'xxx';

-- 5. Soros의 가중치 (자유 조정 여부)
SELECT * FROM soros_weight_adjustments WHERE cycle_id = 'xxx';
```

---

## 9. 미해결 항목

- [ ] **PC 워커와 클라우드 동기화 빈도**: 현재 1일 1회. 실시간 필요한가?
- [ ] **Supabase Realtime 구독 범위**: 어떤 테이블 변경을 즉시 푸시?
- [ ] **데이터 보존 정책 자동화**: 보존 기간 지난 데이터 자동 삭제?
- [ ] **백업 전략**: Supabase 자체 백업 외 추가 백업?
- [ ] **장애 시 그레이스풀 디그라데이션**: 일부 장애 시 부분 작동 정의 더 필요

---

**다음 단계: 호출 흐름 정의서 (사용자 대화 시나리오)**
