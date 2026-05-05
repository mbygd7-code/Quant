# QuantSignal Skill Reference

> 아키텍처 + DB 스키마 + API 매트릭스 + US-KR 매핑 + 가중 공식
> 변경 시 사용자 명시 승인 필요. 특히 **7요소 가중치**와 **US-KR 매핑 테이블**은 알파의 핵심.

---

## 1. Pipeline Timeline (PDF 13p 기준)

```
06:00 KST  ──► [1] System Wake     orchestrator/pipeline.py
06:00~06:15 ─► [2] Acquisition      collectors/* 병렬 실행
06:15~06:30 ─► [3] Refinement       refinery/*
06:30~07:00 ─► [4] Cognitive Integ. cognition/*
07:00~07:30 ─► [5] Predictive Out.  signal/*
07:30       ──► [6] Notify          notifier/telegram.py (Beta) → notifier/kakao.py (Phase 2)
09:00~15:30 ─► [7] Live Monitor     (Phase 2)
15:30+     ──► [8] Result Capture  predictions vs actual 저장
```

각 단계는 독립 실행 가능해야 함. `python -m orchestrator.run --step=acquisition` 식.

---

## 2. DB Schema (Supabase PostgreSQL 15 + pgvector)

> 마이그레이션 파일 위치: `supabase/migrations/`
> 파일명 규칙: `YYYYMMDDHHMMSS_<description>.sql` (Supabase CLI 표준)
> 직접 Supabase Dashboard SQL Editor에서 수정 금지 — 항상 마이그레이션 파일로 관리

### 2-0. 사전 작업 (Supabase Dashboard)

```sql
-- Database → Extensions에서 활성화 후, 마이그레이션 파일에도 명시
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_cron;  -- 선택 (스케줄링은 Python에서 처리해도 됨)
```

### 2-1. 핵심 테이블

```sql
-- 종목 마스터
CREATE TABLE stocks (
  id          SERIAL PRIMARY KEY,
  ticker      VARCHAR(10) UNIQUE NOT NULL,  -- 6자리 한국, 1~5자 미국
  name        VARCHAR(100) NOT NULL,
  market      VARCHAR(20) NOT NULL,         -- KOSPI, KOSDAQ, NASDAQ, NYSE
  sector      VARCHAR(50),
  industry    VARCHAR(100),
  is_watchlist BOOLEAN DEFAULT FALSE,        -- 관심 50종목 표시
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 미국 → 한국 매핑 (알파의 핵심)
CREATE TABLE us_kr_mapping (
  id              SERIAL PRIMARY KEY,
  us_symbol       VARCHAR(10) NOT NULL,
  kr_ticker       VARCHAR(10) NOT NULL,
  relation_type   VARCHAR(50),               -- 'supply_chain', 'competitor', 'sector_proxy'
  impact_strength FLOAT NOT NULL CHECK (impact_strength BETWEEN 0 AND 1),
  rationale       TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (us_symbol, kr_ticker)
);

-- 한국 시장 일별 데이터
CREATE TABLE korea_market (
  date              DATE NOT NULL,
  ticker            VARCHAR(10) NOT NULL,
  open              INTEGER,
  high              INTEGER,
  low               INTEGER,
  close             INTEGER,
  volume            BIGINT,
  trading_value     BIGINT,
  foreign_net_buy   BIGINT,
  institution_net_buy BIGINT,
  change_rate       FLOAT,
  PRIMARY KEY (date, ticker)
);

-- 글로벌 시장 데이터
CREATE TABLE global_market (
  date         DATE NOT NULL,
  symbol       VARCHAR(20) NOT NULL,         -- NVDA, ^IXIC, ^SOX, DXY, USDKRW=X 등
  close        FLOAT,
  change_rate  FLOAT,
  volume       BIGINT,
  asset_class  VARCHAR(20),                  -- 'equity', 'index', 'fx', 'commodity', 'rate'
  PRIMARY KEY (date, symbol)
);

-- 뉴스 (감성 + 임베딩)
CREATE TABLE news_items (
  id                SERIAL PRIMARY KEY,
  date              DATE NOT NULL,
  published_at      TIMESTAMPTZ,
  source            VARCHAR(50),
  title             TEXT NOT NULL,
  body              TEXT,
  url               TEXT UNIQUE,
  related_symbols   TEXT[],                  -- ['NVDA', '000660']
  sentiment_score   FLOAT CHECK (sentiment_score BETWEEN 0 AND 1),
  sentiment_label   VARCHAR(20),
  importance        VARCHAR(10),             -- 'low', 'medium', 'high'
  embedding         VECTOR(1536),
  created_at        TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON news_items USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON news_items (date);

-- 공시 (DART + SEC)
CREATE TABLE filings (
  id           SERIAL PRIMARY KEY,
  date         DATE NOT NULL,
  company      VARCHAR(100),
  ticker       VARCHAR(10),
  market       VARCHAR(20),                  -- 'KR', 'US'
  filing_type  VARCHAR(50),                  -- 'earnings', 'capital_increase', '10-K' 등
  summary      TEXT,
  risk_label   VARCHAR(20),                  -- 'positive', 'neutral', 'caution', 'risk'
  raw_url      TEXT
);

-- AI 점수 (일별 종목별)
CREATE TABLE ai_scores (
  date                    DATE NOT NULL,
  ticker                  VARCHAR(10) NOT NULL,
  global_market_score     FLOAT,
  sector_score            FLOAT,
  related_us_stock_score  FLOAT,
  news_sentiment_score    FLOAT,
  fundamental_score       FLOAT,
  volume_flow_score       FLOAT,
  risk_penalty            FLOAT,
  final_score             FLOAT NOT NULL,
  signal                  VARCHAR(20) NOT NULL,  -- 강한관심/관심/관망/주의/위험
  rationale_json          JSONB,                 -- 근거 3개, 리스크 2개
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (date, ticker)
);

-- ML 예측
CREATE TABLE predictions (
  date                DATE NOT NULL,
  ticker              VARCHAR(10) NOT NULL,
  prob_up             FLOAT,                 -- 다음날 +1% 이상 상승 확률
  expected_volatility VARCHAR(10),
  gap_risk            VARCHAR(10),
  model_confidence    FLOAT,
  model_version       VARCHAR(20),
  PRIMARY KEY (date, ticker)
);

-- 백테스트 결과
CREATE TABLE backtest_results (
  strategy_id   VARCHAR(50) NOT NULL,
  date          DATE NOT NULL,
  ticker        VARCHAR(10) NOT NULL,
  signal        VARCHAR(20),
  entry_price   INTEGER,
  exit_price    INTEGER,
  actual_return FLOAT,
  hit           BOOLEAN,
  PRIMARY KEY (strategy_id, date, ticker)
);

-- 백테스트 작업 (사용자 트리거 비동기 실행)
CREATE TABLE backtest_jobs (
  id              UUID PRIMARY KEY,
  status          VARCHAR(20) NOT NULL DEFAULT 'queued',  -- queued|running|completed|failed
  params          JSONB NOT NULL,                         -- {start_date, end_date, strategy, ...}
  progress        INTEGER DEFAULT 0,                      -- 0~100
  result_url      TEXT,                                   -- Storage signed URL (PNG/HTML)
  error           TEXT,
  run_url         TEXT,                                   -- GitHub Actions 실행 URL
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);
CREATE INDEX ON backtest_jobs (created_by, created_at DESC);
CREATE INDEX ON backtest_jobs (status);

-- RAG 청크
CREATE TABLE rag_chunks (
  id                 VARCHAR(50) PRIMARY KEY,
  topic              TEXT NOT NULL,
  markets            TEXT[],
  sectors            TEXT[],
  related_tickers    TEXT[],
  trigger_conditions TEXT[],
  positive_signal    VARCHAR(20),
  risk_warning       TEXT,
  body               TEXT NOT NULL,
  embedding          VECTOR(1536),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON rag_chunks USING ivfflat (embedding vector_cosine_ops);

-- 알림 발송 로그
CREATE TABLE notifications (
  id          SERIAL PRIMARY KEY,
  date        DATE NOT NULL,
  channel     VARCHAR(20),                   -- 'telegram', 'kakao'
  recipient   VARCHAR(100),
  payload     JSONB,
  status      VARCHAR(20),                   -- 'sent', 'failed'
  error       TEXT,
  sent_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 사용자 프로필 (auth.users 확장)
CREATE TABLE profiles (
  id                 UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email              VARCHAR(255) NOT NULL,
  display_name       VARCHAR(100),
  role               VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'beta', 'user')),
  telegram_chat_id   VARCHAR(50),                  -- 연동 시 채워짐
  telegram_link_code VARCHAR(10),                  -- 일회용 연동 코드
  link_code_expires_at TIMESTAMPTZ,
  notification_enabled BOOLEAN DEFAULT TRUE,
  notification_time  TIME DEFAULT '06:30',         -- 사용자별 발송 시각 (Phase 2)
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON profiles (telegram_chat_id);
CREATE INDEX ON profiles (role);

-- 사용자별 관심종목 (3단계 권한별 제한)
CREATE TABLE user_watchlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  ticker      VARCHAR(10) NOT NULL,
  added_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, ticker)
);
CREATE INDEX ON user_watchlists (user_id);

-- beta 초대 코드
CREATE TABLE invite_codes (
  code        VARCHAR(20) PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'beta',
  created_by  UUID REFERENCES profiles(id),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  used_by     UUID REFERENCES profiles(id),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 사용자 피드백
CREATE TABLE user_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  ticker      VARCHAR(10),                          -- NULL이면 일반 피드백
  accuracy_score INTEGER CHECK (accuracy_score BETWEEN 1 AND 5),
  usefulness_score INTEGER CHECK (usefulness_score BETWEEN 1 AND 5),
  comment     TEXT,
  source      VARCHAR(20),                          -- 'web', 'telegram'
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 가중치 설정 버전 관리 (admin이 조정 시 히스토리)
CREATE TABLE weight_configs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version                  VARCHAR(20) NOT NULL,
  global_market_weight     FLOAT NOT NULL DEFAULT 0.20,
  sector_weight            FLOAT NOT NULL DEFAULT 0.20,
  related_us_stock_weight  FLOAT NOT NULL DEFAULT 0.20,
  news_sentiment_weight    FLOAT NOT NULL DEFAULT 0.15,
  fundamental_weight       FLOAT NOT NULL DEFAULT 0.10,
  volume_flow_weight       FLOAT NOT NULL DEFAULT 0.10,
  risk_penalty_weight      FLOAT NOT NULL DEFAULT 0.05,
  signal_threshold_strong  FLOAT NOT NULL DEFAULT 0.80,
  signal_threshold_interest FLOAT NOT NULL DEFAULT 0.65,
  signal_threshold_neutral FLOAT NOT NULL DEFAULT 0.50,
  signal_threshold_caution FLOAT NOT NULL DEFAULT 0.35,
  is_active                BOOLEAN NOT NULL DEFAULT FALSE,
  created_by               UUID REFERENCES profiles(id),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  notes                    TEXT
);
CREATE UNIQUE INDEX one_active_weight_config ON weight_configs (is_active) WHERE is_active = TRUE;

-- 감사 로그 (admin 편집 행위 기록)
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES profiles(id),
  action      VARCHAR(50) NOT NULL,                 -- 'mapping.update', 'rag_chunk.create' 등
  resource_type VARCHAR(50),
  resource_id VARCHAR(100),
  changes     JSONB,                                -- {before: {...}, after: {...}}
  ip_address  INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX ON audit_logs (user_id);
CREATE INDEX ON audit_logs (action);
CREATE INDEX ON audit_logs (created_at DESC);
```

---

## 3. 7요소 가중 스코어링 공식

> **변경 시 사용자 명시 승인 필요.** 백테스트 결과에 따라 분기별로 재조정.

```
final_score =
    0.20 × global_market_score        # Nasdaq, S&P500, SOX 종합
  + 0.20 × sector_score               # 해당 섹터 미국 ETF (SOXX, XLE 등)
  + 0.20 × related_us_stock_score     # us_kr_mapping × impact_strength
  + 0.15 × news_sentiment_score       # 관련 뉴스 가중평균
  + 0.10 × fundamental_score          # 최근 공시·실적 (Phase 2부터)
  + 0.10 × volume_flow_score          # 외국인/기관 수급
  − 0.05 × risk_penalty               # 단기 과열, 변동성 등

각 sub_score 범위: 0.0 ~ 1.0 (risk_penalty는 0.0 ~ 1.0이며 차감)
```

### 신호 등급 (5단계)

| 점수 범위 | 신호 | 색상 (Telegram 이모지) |
|---|---|---|
| ≥ 0.80 | 강한 관심 | 🟢 녹색 |
| 0.65 ~ 0.79 | 관심 | 🔵 파랑 |
| 0.50 ~ 0.64 | 관망 | ⚪ 회색 |
| 0.35 ~ 0.49 | 주의 | 🟡 노랑 |
| < 0.35 | 위험 | 🔴 빨강 |

---

## 4. US-KR Mapping 초기 매트릭스

> 50종목에 대한 매핑. Phase 1에서 수동 정의 후, Phase 2부터 AI 보조 업데이트.

### 4-1. 반도체

| US Symbol | KR Ticker | KR Name | Relation | Impact |
|---|---|---|---|---|
| NVDA | 000660 | SK하이닉스 | HBM 공급 | 0.92 |
| NVDA | 042700 | 한미반도체 | 후공정 장비 | 0.85 |
| NVDA | 005930 | 삼성전자 | HBM 경쟁 | 0.75 |
| NVDA | 058470 | 리노공업 | 테스트 소켓 | 0.70 |
| NVDA | 039030 | 이오테크닉스 | 레이저 장비 | 0.65 |
| AMD | 000660 | SK하이닉스 | 메모리 공급 | 0.80 |
| AMD | 005930 | 삼성전자 | 메모리 공급 | 0.75 |
| MU | 000660 | SK하이닉스 | 직접 경쟁 | 0.90 |
| MU | 005930 | 삼성전자 | 직접 경쟁 | 0.85 |
| TSM | 042700 | 한미반도체 | 후공정 수요 | 0.72 |
| TSM | 005930 | 삼성전자 | 파운드리 경쟁 | 0.55 |
| ASML (^SOX 포함) | 240810 | 원익IPS | 반도체 장비 | 0.70 |
| ASML | 005290 | 동진쎄미켐 | 반도체 소재 | 0.65 |
| ASML | 357780 | 솔브레인 | 반도체 소재 | 0.65 |

### 4-2. 2차전지

| US/EU Symbol | KR Ticker | Relation | Impact |
|---|---|---|---|
| TSLA | 373220 | LG에너지솔루션 | 셀 공급 | 0.88 |
| TSLA | 006400 | 삼성SDI | 셀 공급 | 0.82 |
| TSLA | 247540 | 에코프로비엠 | 양극재 | 0.80 |
| TSLA | 086520 | 에코프로 | 지주사 | 0.75 |
| TSLA | 003670 | 포스코퓨처엠 | 양극재 | 0.78 |
| TSLA | 066970 | 엘앤에프 | 양극재 | 0.75 |
| RIVN | 373220 | LG에너지솔루션 | 셀 공급 | 0.55 |
| LIT (ETF) | 278280 | 천보 | 전해질 첨가제 | 0.70 |
| LIT | 005070 | 코스모신소재 | 양극재 전구체 | 0.68 |

### 4-3. 자동차

| US Symbol | KR Ticker | Relation | Impact |
|---|---|---|---|
| TSLA | 005380 | 현대차 | 글로벌 EV 경쟁 | 0.55 |
| TSLA | 000270 | 기아 | 글로벌 EV 경쟁 | 0.55 |
| F | 005380 | 현대차 | 글로벌 자동차 | 0.50 |
| GM | 005380 | 현대차 | 글로벌 자동차 | 0.50 |
| (USD/KRW 환율 강) | 005380 | 현대차 | 수출 수혜 | 0.85 |
| (USD/KRW 환율 강) | 000270 | 기아 | 수출 수혜 | 0.85 |
| (USD/KRW 환율 강) | 012330 | 현대모비스 | 수출 부품 | 0.70 |
| MGA | 204320 | HL만도 | 글로벌 부품사 | 0.60 |
| APTV | 018880 | 한온시스템 | 글로벌 부품사 | 0.55 |

### 4-4. 바이오/헬스

| US Symbol | KR Ticker | Relation | Impact |
|---|---|---|---|
| LLY (GLP-1) | 196170 | 알테오젠 | 바이오 라이선스 | 0.65 |
| MRK | 207940 | 삼성바이오로직스 | CMO 수주 | 0.60 |
| PFE | 207940 | 삼성바이오로직스 | CMO 수주 | 0.60 |
| BIIB | 068270 | 셀트리온 | 바이오시밀러 | 0.65 |
| (XBI ETF) | 028300 | HLB | 바이오 섹터 | 0.55 |
| (XBI ETF) | 141080 | 리가켐바이오 | 바이오 섹터 | 0.55 |
| NVO | 196170 | 알테오젠 | 비만치료제 라이선스 | 0.70 |

### 4-5. 인터넷/AI

| US Symbol | KR Ticker | Relation | Impact |
|---|---|---|---|
| GOOGL | 035420 | NAVER | 검색·광고 | 0.55 |
| META | 035420 | NAVER | 광고 시장 | 0.50 |
| MSFT | 035420 | NAVER | 클라우드·AI | 0.55 |
| MSFT | 035720 | 카카오 | 클라우드·AI | 0.50 |
| NVDA | 007660 | 이수페타시스 | AI 서버 PCB | 0.85 |
| NVDA | 093320 | 케이아이엔엑스 | IDC | 0.65 |
| (XLK ETF) | 012510 | 더존비즈온 | SaaS | 0.50 |

---

## 5. API 매트릭스 (PDF 12p)

| API | 용도 | 호출 한계 | 접근 방식 | Wrapper 위치 |
|---|---|---|---|---|
| KRX OpenAPI (pykrx) | 국내 시세·수급 | 일 10,000 | Python SDK | `collectors/krx.py` |
| Finnhub | 글로벌 주가·뉴스·13F | 60/min (free) | Python SDK | `collectors/finnhub.py` |
| EdgarTools | SEC 공시 95개 표준 지표 | 미국 SEC 가이드라인 | Python SDK | `collectors/edgar.py` |
| Alpha Vantage (배치) | 환율·글로벌 거시 보조 | 25 req/day premium, 500 req/day standard (free) | Python SDK | `collectors/alpha_vantage.py` (선택) |
| Alpha Vantage MCP | admin ad-hoc 분석 | API key 기준 | **MCP 클라이언트** | `cognition/mcp_clients/alpha_vantage.py` |
| DART OpenAPI | 한국 공시 | 일 20,000 | Python SDK | `collectors/dart.py` |
| OpenAI Embeddings | RAG 임베딩 | 토큰 기준 과금 | Python SDK | `cognition/rag/embedder.py` |
| Anthropic Claude | 감성·리포트 | 토큰 기준 과금 | Python SDK | `cognition/sentiment.py`, `signal/report.py` |
| Telegram Bot API | 알림 발송 | 30 msg/sec | Python SDK | `notifier/telegram.py` |
| Kakao Biz Message | 알림 발송 (Phase 2) | 계약 기준 | Python SDK | `notifier/kakao.py` (stub) |

### 5-1. MCP vs SDK 사용 원칙

**MCP를 쓰는 경우** (대화형·동적):
- LLM 에이전트가 도구를 자율적으로 선택해서 호출할 때
- admin이 웹앱에서 ad-hoc 분석 질문을 던질 때
- Claude Code에서 데이터 탐색·디버깅할 때
- 예: "NVDA의 최근 RSI와 MACD를 보여주고, 한국 반도체 종목과의 상관관계를 분석해줘"

**SDK를 쓰는 경우** (배치·결정론적):
- 매일 06:00 KST 정해진 50종목 × 정해진 필드 수집
- 동일 입력 → 동일 출력이 보장되어야 할 때 (재현성)
- GitHub Actions Runner에서 60분 내 완료해야 할 때
- 비용·rate limit 관리가 중요할 때 (LLM 추론 토큰 절약)

**둘을 같이 쓰는 경우**:
- Alpha Vantage는 양쪽 모두 사용 — 배치용 (collectors/, 선택)와 대화형 (cognition/mcp_clients/, admin ad-hoc)
- Finnhub은 SDK만 사용 — 공식 MCP 부재 + 우리 용도는 배치 수집 중심

### 5-2. Alpha Vantage MCP 통합

**공식 원격 MCP 서버**: `https://mcp.alphavantage.co/`
- Alpha Vantage가 호스팅 (자체 서버 구축 불필요)
- API key만 발급받아 클라이언트에서 사용
- "Progressive Tool Discovery" 기법으로 토큰 비용 최적화

**활용 시나리오 — 웹앱 `/admin/analyze` 페이지** (Phase 2):
- admin이 자연어 질문 입력
- 백엔드 (apps/api 또는 GitHub Actions)가 Claude API + Alpha Vantage MCP 조합으로 응답
- 예: "지난 30일 동안 SK하이닉스와 NVDA의 가격 상관관계는?" → MCP로 두 종목 시계열 조회 → 상관계수 계산 → 차트 생성

**활용 시나리오 — Claude Code 개발 시**:
- 베이영 님이 Claude Code에서 데이터 탐색
- `~/.config/claude-code/mcp.json`에 Alpha Vantage MCP 설정
- 디버깅·feature 검증·일회성 분석에 활용

**MVP에서는 활용 보류**:
- Phase 1 MVP에서는 Alpha Vantage MCP 통합 페이지 만들지 않음
- Phase 2 또는 사용자 요청 시 추가
- 단, Claude Code 로컬 환경에서는 베이영 님이 자유롭게 활용 가능

### 5-3. Finnhub은 SDK만 사용 (MCP 안 씀)

**이유**:
1. 공식 Finnhub MCP 서버가 없음 (커뮤니티 C#/Python 서버만 있고 자체 호스팅 필요)
2. 우리 용도는 매일 정형 배치 수집 → SDK가 더 적합
3. GitHub Actions Runner에서 추가 MCP 서버 호스팅은 복잡도 증가

**collectors/finnhub.py에서 그대로 SDK 사용**:
```python
import finnhub
client = finnhub.Client(api_key=os.environ["FINNHUB_API_KEY"])

# 일별 OHLC
candles = client.stock_candles("NVDA", "D", from_ts, to_ts)
# 회사 뉴스
news = client.company_news("NVDA", _from="2026-05-01", to="2026-05-06")
# 13F 보유 현황
filings = client.filings(symbol="NVDA")
```

향후 Finnhub이 공식 MCP를 출시하면 그때 통합 검토.

---

## 6. Notification Format

### 6-1. Telegram (Beta) — MarkdownV2 + Inline Keyboard

**일일 프리뷰 메시지**

```
📊 *2026\-05\-06 한국장 프리뷰*

🌡 *글로벌 온도*: 🟢 긍정
\- Nasdaq \+1\.8%, SOX \+2\.1%, VIX 하락
\- USD/KRW 강세, 美 10년물 안정

🏭 *섹터 온도*
🟢 반도체 \(강세\) \| ⚪ 2차전지 \(중립\)
🟡 자동차 \(주의\) \| ⚪ 바이오 \| 🟢 인터넷/AI

🔝 *상위 5종목*
1\. 🟢 SK하이닉스 `0.78`
2\. 🟢 한미반도체 `0.74`
3\. 🔵 이수페타시스 `0.71`
4\. 🔵 삼성전자 `0.68`
5\. ⚪ NAVER `0.55`

_본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다\._
```

**Inline Keyboard**:
```python
[
  [("📋 전체 종목 보기", "callback:list_all"),
   ("🏭 섹터별 보기", "callback:by_sector")],
  [("🔝 SK하이닉스 상세", "callback:detail:000660"),
   ("🔝 한미반도체 상세", "callback:detail:042700")],
  [("⚙️ 설정", "callback:settings")]
]
```

**개별 종목 상세 메시지**

```
🟢 *SK하이닉스* `005930`
신호: *관심* \(점수 0\.78\)

✅ *긍정 요인*
• Nvidia \+3\.2%, SOX \+2\.1%
• HBM3E 공급 확대 뉴스 \(감성 0\.86\)
• 외국인 5일 연속 순매수

⚠️ *리스크*
• 전일 \+4\.5% 단기 과열
• 장 초반 갭상승 시 추격매수 위험

💬 *AI 코멘트*
오늘은 반도체 업종의 글로벌 선행 신호가 강합니다\.
다만 장 초반 급등 시 추격매수보다 가격 안정 확인이 필요합니다\.

_본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다\._
```

**Inline Keyboard (개별 종목)**:
```python
[
  [("📰 관련 뉴스", "callback:news:000660"),
   ("📈 차트 보기", "callback:chart:000660")],
  [("⬅️ 이전", "callback:prev:000660"),
   ("➡️ 다음", "callback:next:000660")],
  [("🏠 메인으로", "callback:home")]
]
```

### 6-2. Telegram 명령어 핸들러

| 명령어 | 동작 |
|---|---|
| `/start` | 환영 메시지 + 사용 가이드 |
| `/today` | 오늘 프리뷰 재발송 |
| `/stock <ticker>` | 종목 상세 (예: `/stock 005930`) |
| `/sector <name>` | 섹터 요약 (반도체/2차전지/자동차/바이오/인터넷) |
| `/top` | 상위 5종목 |
| `/risk` | "주의" 또는 "위험" 신호 종목만 |
| `/help` | 명령어 안내 |

### 6-3. Kakao 알림톡 (Phase 2)

```
[QuantSignal] 2026-05-06 프리뷰

종목: SK하이닉스 (000660)
신호: 관심 (0.78)

▶ 긍정 요인
• Nvidia +3.2%, SOX +2.1%
• HBM3E 공급 확대 뉴스
• 외국인 5일 연속 순매수

▶ 리스크
• 전일 +4.5% 단기 과열
• 장 초반 갭상승 가능성

※ 본 정보는 투자 판단 보조 자료이며
  매매 권유가 아닙니다.
```

### 6-4. MarkdownV2 이스케이프 주의사항

텔레그램 MarkdownV2는 `_*[]()~`>#+-=|{}.!` 문자를 모두 이스케이프해야 함.

```python
def escape_md(text: str) -> str:
    """Telegram MarkdownV2 escape"""
    chars = r"_*[]()~`>#+-=|{}.!"
    for c in chars:
        text = text.replace(c, f"\\{c}")
    return text
```

`notifier/telegram.py`의 모든 동적 텍스트(종목명, 점수, 근거 문장)는 이 함수를 거쳐야 함.

---

## 7. Executor 인터페이스 (Phase 3 대비)

```python
# executor/broker_interface.py
from abc import ABC, abstractmethod

class BrokerInterface(ABC):
    @abstractmethod
    def get_balance(self) -> dict: ...
    @abstractmethod
    def place_order(self, ticker: str, side: str, qty: int, price: int | None) -> str: ...
    @abstractmethod
    def get_positions(self) -> list[dict]: ...

# Phase 1~2에서 구현
class PaperBroker(BrokerInterface): ...

# Phase 3에서 사용자 승인 후 구현
class KISBroker(BrokerInterface):
    def __init__(self): raise NotImplementedError("Phase 3 only")

class KiwoomBroker(BrokerInterface):
    def __init__(self): raise NotImplementedError("Phase 3 only")
```

환경변수 `EXECUTION_MODE`:
- `report_only` (Phase 1, 기본값)
- `paper` (Phase 2)
- `kis_real`, `kiwoom_real` (Phase 3, 사용자 명시 승인)

---

## 8. Feature Engineering for GBM

```python
features = [
    # 글로벌 (전일 미국장)
    "us_nasdaq_change",
    "us_sp500_change",
    "us_sox_change",
    "vix",
    "us_10y_yield",
    "dxy",
    "usdkrw",
    "wti",

    # 관련 미국 종목 (매핑 weighted)
    "related_us_avg_change",

    # 한국 (전일)
    "kr_close_change",
    "kr_volume_zscore",
    "foreign_net_5d",
    "institution_net_5d",

    # 뉴스
    "news_sentiment_avg",
    "news_count",
]

target = "next_day_return >= 0.01"  # 이진 분류
```

---

## 9. 환경변수 (`.env.example`)

```bash
# ====== Supabase ======
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=eyJh...                    # 클라이언트용 (RLS 적용)
SUPABASE_SERVICE_ROLE_KEY=eyJh...            # 백엔드 전용 (RLS 우회) — 절대 노출 금지

# Direct Postgres connection (대량 INSERT, 백테스트 등 supabase-py로 비효율인 경우만)
SUPABASE_DB_HOST=db.<project-ref>.supabase.co
SUPABASE_DB_PORT=5432
SUPABASE_DB_NAME=postgres
SUPABASE_DB_USER=postgres
SUPABASE_DB_PASSWORD=                        # Supabase Dashboard → Settings → Database

# Storage 버킷 이름 (Supabase Dashboard에서 미리 생성)
SUPABASE_BUCKET_RAW=raw-api-backups
SUPABASE_BUCKET_BACKTEST=backtest-reports
SUPABASE_BUCKET_REPORTS=daily-reports

# ====== Cache ======
REDIS_URL=redis://localhost:6379/0           # 또는 Upstash URL

# ====== AI ======
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# ====== Data sources ======
FINNHUB_API_KEY=
DART_API_KEY=
ALPHA_VANTAGE_KEY=

# ====== Notification (Beta — Telegram) ======
TELEGRAM_BOT_TOKEN=                          # BotFather에서 발급
TELEGRAM_CHAT_IDS=                           # 콤마 구분 (운영자 + 베타 테스터 chat_id)
TELEGRAM_ADMIN_CHAT_ID=                      # 운영자 본인 chat_id (오류 알림용)
TELEGRAM_WEBHOOK_SECRET=                     # Vercel webhook 인증용 (16자 이상 랜덤)
TELEGRAM_USE_WEBHOOK=true                    # Vercel: true / 로컬 polling: false

# ====== Notification (Phase 2 — Kakao, 비활성) ======
KAKAO_BIZ_API_KEY=
KAKAO_TEMPLATE_ID=

# ====== Notification 채널 선택 ======
NOTIFY_CHANNELS=telegram                     # telegram | kakao | telegram,kakao
DRY_RUN=false                                # true면 실제 발송 안 하고 콘솔 출력만

# ====== Execution ======
EXECUTION_MODE=report_only                   # report_only | paper | kis_real | kiwoom_real

# ====== Schedule ======
PIPELINE_RUN_TIME=06:00                      # KST
TIMEZONE=Asia/Seoul
```

## 10. Supabase Client Patterns

### 10-1. 클라이언트 초기화 (`db/supabase_client.py`)

```python
import os
from supabase import create_client, Client
from functools import lru_cache

@lru_cache(maxsize=1)
def get_admin_client() -> Client:
    """백엔드 워커 전용 — Service Role Key (RLS 우회)"""
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_SERVICE_ROLE_KEY"],
    )

@lru_cache(maxsize=1)
def get_anon_client() -> Client:
    """클라이언트용 (Phase 2 웹 인터페이스 시) — RLS 적용"""
    return create_client(
        os.environ["SUPABASE_URL"],
        os.environ["SUPABASE_ANON_KEY"],
    )
```

### 10-2. 데이터 입출력 패턴

**대량 INSERT (수집 데이터 적재):**
```python
# 50종목 × 일별 데이터 → upsert
sb = get_admin_client()
sb.table("korea_market").upsert(
    rows,                              # list[dict]
    on_conflict="date,ticker"
).execute()
```

**pgvector 유사도 검색 — RPC 함수 활용:**
```sql
-- supabase/migrations/xxx_match_rag_chunks.sql
CREATE OR REPLACE FUNCTION match_rag_chunks(
    query_embedding vector(1536),
    match_count int,
    filter_tickers text[] DEFAULT NULL
)
RETURNS TABLE (id varchar, topic text, body text, similarity float)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT c.id, c.topic, c.body,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM rag_chunks c
  WHERE filter_tickers IS NULL
     OR c.related_tickers && filter_tickers
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END; $$;
```

```python
# Python에서 호출
result = sb.rpc("match_rag_chunks", {
    "query_embedding": embedding,
    "match_count": 5,
    "filter_tickers": ["NVDA", "000660"],
}).execute()
```

**Storage 업로드 (백테스트 PNG):**
```python
sb.storage.from_("backtest-reports").upload(
    path=f"{date.isoformat()}/{strategy_id}.png",
    file=png_bytes,
    file_options={"content-type": "image/png"},
)
```

**대량 read 또는 백테스트 (psycopg 직접 연결):**
```python
# supabase-py는 PostgREST 경유라 대량 read 시 성능 손해
# 백테스트처럼 수만 행 읽을 때는 psycopg로 직접 connection
import psycopg
conn = psycopg.connect(
    host=os.environ["SUPABASE_DB_HOST"],
    port=os.environ["SUPABASE_DB_PORT"],
    dbname=os.environ["SUPABASE_DB_NAME"],
    user=os.environ["SUPABASE_DB_USER"],
    password=os.environ["SUPABASE_DB_PASSWORD"],
    sslmode="require",
)
```

### 10-3. RLS 정책 예시 (Phase 2 사용자 데이터용)

```sql
-- Phase 2 — 사용자별 관심종목
CREATE TABLE user_watchlists (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
    ticker varchar(10) NOT NULL,
    created_at timestamptz DEFAULT now()
);

ALTER TABLE user_watchlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_watchlist"
    ON user_watchlists FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_watchlist"
    ON user_watchlists FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "users_delete_own_watchlist"
    ON user_watchlists FOR DELETE
    USING (auth.uid() = user_id);

-- Phase 1의 시장 데이터 테이블은 service_role만 쓰기, anon read는 차단
ALTER TABLE korea_market ENABLE ROW LEVEL SECURITY;
-- 정책을 하나도 만들지 않으면 anon은 접근 불가, service_role은 항상 우회
```

### 10-4. Storage 버킷 구조

```
raw-api-backups/                    # private
├── 2026-05-05/
│   ├── krx.json
│   ├── finnhub_indices.json
│   ├── finnhub_news.json
│   └── edgar.json
└── 2026-05-06/...

backtest-reports/                   # private
├── 2026Q1/
│   ├── score_above_065.png
│   ├── score_above_065.html
│   └── calibration_plot.png
└── 2026Q2/...

daily-reports/                      # private
├── 2026-05-06/
│   ├── preview.md
│   ├── 005930_SK하이닉스.md
│   └── ...
```

버킷은 모두 private. 운영자가 다운로드할 때만 signed URL 생성 (`generate_signed_url`, expires_in=3600).

### 10-5. Supabase 연결 실패 처리

```python
# orchestrator/pipeline.py 시작 시 health check
def verify_supabase_connection():
    try:
        sb = get_admin_client()
        sb.table("stocks").select("id").limit(1).execute()
    except Exception as e:
        # Telegram 운영자 알림 + 파이프라인 중단
        raise SystemExit(f"Supabase 연결 실패: {e}")
```

## 11. Deployment Architecture (GitHub + Vercel)

### 11-1. 전체 구조

```
┌─────────────────────────────────────────────────────────────┐
│                      GitHub (monorepo)                       │
│                                                              │
│   apps/web/  ◄── Vercel (Next.js, root)                      │
│   apps/api/  ◄── Vercel (FastAPI Functions, /api/*)          │
│                                                              │
│   .github/workflows/                                         │
│   ├── ci.yml             — lint + test (PR/push)             │
│   ├── migrate.yml        — supabase db push                  │
│   ├── daily-pipeline.yml — 매일 06:00 KST cron               │
│   └── backtest.yml       — 사용자 트리거 백테스트            │
└──────────┬───────────────────────────────────────────────────┘
           │
           ├─────────► Vercel (웹 + API, 60초 이내)
           │           ├─ Next.js: 사용자 UI
           │           ├─ FastAPI: Telegram Webhook + 가벼운 API
           │           └─ Storage signed URL 발급
           │
           ├─────────► GitHub Actions Runner (60분 이내)
           │           ├─ Daily Pipeline (06:00 KST cron)
           │           │   └─ 수집 → 정제 → 인지 → 시그널 → 알림
           │           ├─ On-demand Backtest (workflow_dispatch)
           │           └─ Migration (main + supabase/migrations 변경)
           │
           └─────────► Supabase (단일 데이터 소스)
                       ├─ Postgres + pgvector
                       ├─ Auth (3단계 권한)
                       └─ Storage (raw, backtest, reports)

   ┌──────────────────┐
   │  Telegram Bot    │
   │  (Webhook only)  │  ◄── Vercel /api/telegram/webhook
   └──────────────────┘
```

**3개 인프라로 통합**: GitHub + Vercel + Supabase. Railway·VPS 없음.

### 11-2. Vercel 배포 (`apps/web/` + `apps/api/`)

**vercel.json** (저장소 루트):

```json
{
  "version": 2,
  "buildCommand": "cd apps/web && npm install && npm run build",
  "outputDirectory": "apps/web/.next",
  "framework": "nextjs",
  "rootDirectory": "apps/web",
  "functions": {
    "apps/api/**/*.py": {
      "runtime": "python3.11",
      "maxDuration": 60
    }
  },
  "rewrites": [
    { "source": "/api/:path*", "destination": "/apps/api/:path*" }
  ]
}
```

**Vercel Project Settings (대시보드에서 설정):**
- Framework Preset: Next.js
- Root Directory: `apps/web` (Vercel이 자동 감지)
- Build Command: `npm run build` (auto)
- Install Command: `npm install` (auto)
- Python Functions는 `apps/api/`에서 자동으로 Serverless로 변환됨

**apps/web/package.json** (핵심 의존성):

```json
{
  "name": "quant-signal-web",
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "14.2.0",
    "react": "18.3.0",
    "react-dom": "18.3.0",
    "@supabase/supabase-js": "2.45.0",
    "@supabase/ssr": "0.5.0",
    "@tanstack/react-query": "5.51.0",
    "react-hook-form": "7.52.0",
    "@hookform/resolvers": "3.9.0",
    "zod": "3.23.0",
    "recharts": "2.12.0",
    "lucide-react": "0.400.0",
    "clsx": "2.1.0",
    "tailwind-merge": "2.4.0",
    "date-fns": "3.6.0"
  },
  "devDependencies": {
    "typescript": "5.5.0",
    "tailwindcss": "3.4.0",
    "autoprefixer": "10.4.0",
    "postcss": "8.4.0",
    "@types/node": "20.14.0",
    "@types/react": "18.3.0",
    "eslint": "8.57.0",
    "eslint-config-next": "14.2.0"
  }
}
```

shadcn/ui 컴포넌트는 `npx shadcn-ui@latest add button card dialog form input select slider table tabs toast`로 추가.

**apps/api/requirements.txt** (가벼운 의존성만):

```
fastapi==0.115.0
pydantic==2.9.0
supabase==2.7.0
python-telegram-bot[ext]==21.6
mangum==0.17.0
httpx==0.27.0
redis==5.0.0
pyjwt==2.9.0
```

**금지 의존성** (Vercel 250MB 빌드 한계):
- `scikit-learn`, `pykrx`, `edgartools`, `finnhub-python` — GitHub Actions Runner에서만 사용
- `pandas` 가능하지만 무거우므로 가급적 회피

**apps/api/index.py 구조**:

```python
from fastapi import FastAPI, Request, Header, HTTPException
from mangum import Mangum  # Vercel ASGI 어댑터

app = FastAPI(title="QuantSignal API")

@app.get("/health")
async def health():
    return {"status": "ok"}

# Telegram Webhook
@app.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str = Header(None),
):
    # 1. secret token 검증 (Telegram → Webhook 인증)
    if x_telegram_bot_api_secret_token != os.environ["TELEGRAM_WEBHOOK_SECRET"]:
        raise HTTPException(403)

    update_data = await request.json()
    # 2. 명령어 라우팅 → 가벼운 응답만 (DB 조회 결과 포맷팅)
    # 3. 무거운 작업은 GitHub workflow_dispatch로 트리거 (예: 백테스트)
    ...

# 운영자용 관리 엔드포인트
@app.get("/admin/data-quality")
async def data_quality(date: str): ...

@app.get("/admin/cost")
async def cost_report(date: str): ...

# Vercel Serverless 진입점
handler = Mangum(app)
```

### 11-3. GitHub Actions Workflows (워커·스케줄러 역할)

**`.github/workflows/daily-pipeline.yml`** — 매일 06:00 KST 파이프라인 실행:

```yaml
name: Daily Pipeline
on:
  schedule:
    # KST 06:00 = UTC 21:00 (전날) → 한국 월~금 = UTC 일~목
    - cron: "0 21 * * 0-4"
  workflow_dispatch:
    inputs:
      date:
        description: "Run for specific date (YYYY-MM-DD), empty = today"
        required: false
        default: ""

jobs:
  run-pipeline:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    concurrency:
      group: daily-pipeline
      cancel-in-progress: false      # 중복 실행 방지
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
          cache: pip

      - name: Install dependencies
        run: pip install -e .

      - name: Run pipeline
        run: |
          DATE="${{ github.event.inputs.date }}"
          if [ -z "$DATE" ]; then
            python -m orchestrator.pipeline --mode=once --date=today
          else
            python -m orchestrator.pipeline --mode=once --date=$DATE
          fi
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          FINNHUB_API_KEY: ${{ secrets.FINNHUB_API_KEY }}
          DART_API_KEY: ${{ secrets.DART_API_KEY }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_ADMIN_CHAT_ID: ${{ secrets.TELEGRAM_ADMIN_CHAT_ID }}
          EXECUTION_MODE: report_only

      - name: Notify on failure
        if: failure()
        run: |
          curl -X POST \
            "https://api.telegram.org/bot${{ secrets.TELEGRAM_BOT_TOKEN }}/sendMessage" \
            -d "chat_id=${{ secrets.TELEGRAM_ADMIN_CHAT_ID }}" \
            -d "text=🚨 Daily Pipeline 실패: ${{ github.run_id }}%0A${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
```

**`.github/workflows/backtest.yml`** — 사용자 트리거 백테스트:

```yaml
name: On-Demand Backtest
on:
  workflow_dispatch:
    inputs:
      job_id:
        description: "Backtest job ID (Supabase에서 발급)"
        required: true
      start_date:
        description: "YYYY-MM-DD"
        required: true
      end_date:
        description: "YYYY-MM-DD"
        required: true
      strategy:
        description: "전략 키 (예: score_above_065)"
        required: true
        default: "score_above_065"
      weight_config_id:
        description: "weight_configs.id (UUID), 비우면 active 사용"
        required: false

jobs:
  run-backtest:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11", cache: pip }
      - run: pip install -e .

      - name: Update job status to running
        run: |
          python -m signal.backtest_status \
            --job-id="${{ github.event.inputs.job_id }}" \
            --status=running \
            --run-url="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}

      - name: Run backtest
        run: |
          python -m signal.backtest \
            --job-id="${{ github.event.inputs.job_id }}" \
            --start="${{ github.event.inputs.start_date }}" \
            --end="${{ github.event.inputs.end_date }}" \
            --strategy="${{ github.event.inputs.strategy }}" \
            --weight-config-id="${{ github.event.inputs.weight_config_id }}"
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

      - name: Mark complete
        if: always()
        run: |
          STATUS="${{ job.status }}"
          python -m signal.backtest_status \
            --job-id="${{ github.event.inputs.job_id }}" \
            --status="$STATUS"
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
```

**`apps/api`에서 백테스트 트리거** — GitHub REST API 호출:

```python
# apps/api/routes/backtest.py
import os
import uuid
import httpx
from fastapi import APIRouter, Depends, HTTPException

router = APIRouter()

@router.post("/api/backtest/start")
async def start_backtest(req: BacktestRequest, user = Depends(get_current_admin)):
    job_id = str(uuid.uuid4())

    # 1. backtest_jobs 테이블에 'queued' INSERT
    sb.table("backtest_jobs").insert({
        "id": job_id,
        "status": "queued",
        "params": req.dict(),
        "created_by": user.id,
    }).execute()

    # 2. GitHub workflow_dispatch 트리거
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"https://api.github.com/repos/{os.environ['GITHUB_REPO']}/actions/workflows/backtest.yml/dispatches",
            headers={
                "Authorization": f"Bearer {os.environ['GITHUB_PAT']}",
                "Accept": "application/vnd.github+json",
            },
            json={
                "ref": "main",
                "inputs": {
                    "job_id": job_id,
                    "start_date": req.start_date,
                    "end_date": req.end_date,
                    "strategy": req.strategy,
                    "weight_config_id": req.weight_config_id or "",
                },
            },
        )
        r.raise_for_status()

    return {"job_id": job_id, "status": "queued"}
```

`backtest_jobs` 테이블은 Phase 1 마이그레이션에 포함되며, 웹은 Supabase Realtime 또는 폴링으로 상태 추적.

### 11-3-2. (참고) Railway 도입 시 마이그레이션 경로

향후 Railway가 필요해지면 (CLAUDE.md F-2 시나리오) 다음 작업으로 전환:

1. `Dockerfile.worker` 추가 (Python slim 베이스)
2. `railway.toml` 추가 (cron + 워커 정의)
3. `.github/workflows/daily-pipeline.yml` 비활성화
4. Railway Variables에 환경변수 등록
5. `apps/api/routes/backtest.py`의 GitHub workflow_dispatch → Redis enqueue로 교체

이 마이그레이션은 1~2시간 작업으로 가능. **현재는 진행하지 않는다.**

### 11-4. Telegram Bot — Polling vs Webhook

| 환경 | 방식 | 위치 |
|---|---|---|
| 로컬 개발 | Polling | `python -m notifier.bot_runner` |
| Vercel (운영) | Webhook | `apps/api/routes/telegram_webhook.py` |

**Webhook 설정 (1회)**:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://<vercel-domain>/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

`notifier/telegram.py`의 `send_*` 메서드는 Polling/Webhook 무관 (HTTP API 직접 호출). GitHub Actions Runner는 send만 사용 (파이프라인 결과 발송). Vercel은 send + receive 모두 처리 (사용자 명령 응답).

### 11-5. GitHub Actions Workflows (CI + Migration)

**`.github/workflows/ci.yml`** — PR + push:

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  python-lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.11", cache: pip }
      - run: pip install -e ".[dev]"
      - run: ruff check .
      - run: pytest -v
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL_TEST }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY_TEST }}

  web-lint-typecheck:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: apps/web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: npm, cache-dependency-path: apps/web/package-lock.json }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
```

**`.github/workflows/migrate.yml`** — main branch push 시 마이그레이션:

```yaml
name: Supabase Migration
on:
  push:
    branches: [main]
    paths: ["supabase/migrations/**"]

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      - run: supabase db push
        env:
          SUPABASE_DB_PASSWORD: ${{ secrets.SUPABASE_DB_PASSWORD }}
```

**총 4개 워크플로우 파일**:
- `ci.yml` (Python + TypeScript lint + test)
- `migrate.yml` (Supabase 마이그레이션)
- `daily-pipeline.yml` (11-3 참조, 매일 06:00 KST)
- `backtest.yml` (11-3 참조, 사용자 트리거)

**Vercel 자동 배포**: Vercel이 자체적으로 GitHub 연동 → main push 시 자동 배포. Actions에서 별도 deploy 명령 X.

### 11-6. GitHub Secrets 등록 목록

```bash
# Supabase
SUPABASE_PROJECT_REF              # 프로젝트 URL의 서브도메인
SUPABASE_ACCESS_TOKEN             # https://supabase.com/dashboard/account/tokens
SUPABASE_DB_PASSWORD
SUPABASE_URL                      # 운영용 (daily-pipeline, backtest)
SUPABASE_SERVICE_ROLE_KEY         # 운영용

# 테스트용 (선택, ci.yml에서 사용)
SUPABASE_URL_TEST
SUPABASE_SERVICE_ROLE_KEY_TEST

# AI
ANTHROPIC_API_KEY
OPENAI_API_KEY

# Data
FINNHUB_API_KEY
DART_API_KEY

# Telegram
TELEGRAM_BOT_TOKEN
TELEGRAM_ADMIN_CHAT_ID            # 파이프라인 실패·헬스체크 알림용
TELEGRAM_WEBHOOK_SECRET           # Vercel webhook 인증용

# GitHub (apps/api에서 workflow_dispatch 호출용)
# (apps/api는 Vercel에서 실행되므로 Vercel Variables에 등록)
```

**Vercel Variables** (Vercel Dashboard → Settings → Environment Variables):
- 위 모든 키 + `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- 추가: `GITHUB_REPO=baeyoung/quant-signal`, `GITHUB_PAT=...` (workflow_dispatch 호출용 fine-grained token)

**원칙**: 같은 키를 여러 곳에 등록하더라도 코드에서는 `os.environ`만 읽음. 환경별 차이 없음.

### 11-7. .gitignore 핵심

```
.env
.env.*
!.env.example
secrets.kr.local
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.vercel
node_modules/
*.log
logs/
```

## 12. Web App 설계 (Next.js 14 App Router)

### 12-1. 페이지 트리 + 권한

```
/                                        모든 사용자
├── /login                               미인증
├── /invite/[token]                      초대 코드 가입
│
├── /(app)/                              인증 필요 (모든 권한)
│   ├── /dashboard                       전체 — 시장 온도 + 상위 종목
│   ├── /watchlist                       admin: 50종목 전체 / beta·user: 자기 것
│   ├── /reports                         히스토리 목록
│   ├── /reports/[date]                  일자별 프리뷰
│   ├── /reports/[date]/[ticker]         종목 상세
│   └── /settings                        텔레그램 연동·알림 설정
│
└── /(admin)/                            admin only (middleware 검증)
    ├── /mapping                         US-KR 매핑 매트릭스
    ├── /knowledge                       RAG 청크 목록
    ├── /knowledge/[id]                  청크 편집
    ├── /knowledge/new                   청크 생성
    ├── /weights                         가중치 + 임계값
    ├── /backtest                        백테스트 실행·결과
    ├── /admin/users                     사용자 관리
    ├── /admin/data-quality              품질·비용 대시보드
    └── /admin/notifications             알림 로그
```

### 12-2. 페이지별 핵심 UI 설계

#### `/dashboard` — 메인 진입 화면

```
┌─────────────────────────────────────────────────────────────┐
│ QuantSignal                              [날짜] 알림 ⚙️ 👤  │
├──────────┬──────────────────────────────────────────────────┤
│          │  📊 2026-05-06 한국장 프리뷰                      │
│ 사이드바  │                                                  │
│          │  🌡 글로벌 온도                                   │
│ 대시보드  │  ┌───────────┬───────────┬───────────┐           │
│ 관심종목  │  │ Nasdaq    │ SOX       │ VIX       │           │
│ 매핑     │  │ +1.8% 🟢  │ +2.1% 🟢  │ -3% 🟢    │           │
│ 지식     │  └───────────┴───────────┴───────────┘           │
│ 가중치   │                                                  │
│ 백테스트 │  🏭 섹터 온도 (5개)                                │
│ 사용자   │  [반도체 🟢] [2차전지 ⚪] [자동차 🟡] ...          │
│ 품질     │                                                  │
│ 알림로그 │  🔝 상위 5종목 (final_score 기준)                  │
│ 설정     │  ┌──────────────────────────────────────────┐    │
│          │  │ 1. 🟢 SK하이닉스   0.78  관심   📰 →     │    │
│          │  │ 2. 🟢 한미반도체   0.74  관심   📰 →     │    │
│          │  │ ...                                       │    │
│          │  └──────────────────────────────────────────┘    │
└──────────┴──────────────────────────────────────────────────┘
```

데이터 소스: Server Component → `ai_scores` 테이블 (오늘 날짜) + `global_market` 최신.

#### `/watchlist` — 관심종목 관리

- **테이블 뷰** (정렬 가능): 종목명, 섹터, 현재 신호, 점수, 전일 등락률, 외국인 수급, [편집] [삭제]
- 상단 **[+ 종목 추가]** 버튼 → Modal:
  - 종목 검색 (KRX 50종목 내 자동완성)
  - 섹터 자동 표시
  - admin은 50종목 외에도 추가 가능 (DB의 `stocks` 테이블에서 자유 검색)
  - beta·user는 50종목 워치리스트 내에서만
- **권한별 차이**:
  - admin: 50종목 마스터 watchlist 편집 (`stocks.is_watchlist = true`)
  - beta: 자기 `user_watchlists` 편집 (최대 30종목)
  - user: 자기 `user_watchlists` 편집 (최대 10종목, Phase 2)

#### `/mapping` — US-KR 매핑 매트릭스 (admin only)

**가장 중요한 페이지 — 알파의 핵심.**

레이아웃:
```
┌─────────────────────────────────────────────────────────────┐
│ US-KR 매핑 매트릭스               [+ 새 매핑] [내보내기]      │
├─────────────────────────────────────────────────────────────┤
│ 필터: [섹터 ▼] [US 종목 ▼] [Impact ≥ ] [---●---------]      │
├─────────────────────────────────────────────────────────────┤
│ US Symbol │ KR Ticker │ Relation     │ Impact   │ 액션      │
│ NVDA      │ 000660    │ HBM 공급     │ ●●●●●━━━ │ 편집/삭제 │
│           │           │              │  0.92    │           │
│ NVDA      │ 042700    │ 후공정 장비  │ ●●●●━━━━ │ 편집/삭제 │
│           │           │              │  0.85    │           │
│ ...                                                          │
└─────────────────────────────────────────────────────────────┘
```

- **Impact slider**: 0.0 ~ 1.0, 슬라이더 + 숫자 입력 동시 지원
- **인라인 편집**: 행 클릭 → 슬라이더 + 텍스트 입력 노출 → 자동 저장 (debounce 1s)
- **변경사항 미리보기**: "이 변경이 SK하이닉스 점수에 약 +0.05 영향" 같은 시뮬레이션 (선택 기능)
- **변경 시 audit log 자동 기록**

#### `/knowledge` — RAG 청크 관리 (admin only)

목록 페이지:
- 카드 그리드 (3열, 데스크탑) — 청크당 카드 1개
- 카드: topic, sectors 태그, related_tickers, 마지막 수정일
- 필터: 섹터, 마켓, 태그 검색
- **[+ 새 청크]** 버튼

편집 페이지 `/knowledge/[id]`:
- 좌측: 메타데이터 폼 (topic, sectors[], markets[], related_tickers[], trigger_conditions[])
- 우측: body 마크다운 에디터 (실시간 프리뷰)
- 저장 시 → 백엔드(FastAPI) 호출 → 자동 임베딩 재생성 → `rag_chunks.embedding` 업데이트

#### `/weights` — 가중치 + 임계값 (admin only)

```
┌─────────────────────────────────────────────────────────────┐
│ 7요소 가중치 설정                                             │
├─────────────────────────────────────────────────────────────┤
│ 글로벌 시장      [---●---------] 0.20  (현재: 0.20)         │
│ 섹터            [---●---------] 0.20                         │
│ 관련 미국 종목  [---●---------] 0.20                         │
│ 뉴스 감성       [-●-----------] 0.15                         │
│ 펀더멘털        [●------------] 0.10                         │
│ 수급            [●------------] 0.10                         │
│ 리스크 차감     [●------------] 0.05                         │
│                                                              │
│ 합계: 1.00 ✓                          [백테스트 미리보기]    │
├─────────────────────────────────────────────────────────────┤
│ 신호 등급 임계값                                              │
│ 강한 관심  ≥ [0.80]                                          │
│ 관심      ≥ [0.65]                                          │
│ 관망      ≥ [0.50]                                          │
│ 주의      ≥ [0.35]                                          │
│ 위험      <  0.35                                           │
├─────────────────────────────────────────────────────────────┤
│ 변경 사유: [텍스트 입력]                                      │
│                              [버전으로 저장] [활성화]         │
└─────────────────────────────────────────────────────────────┘
```

- 합계가 1.0이 되어야만 저장 가능
- 새 버전 저장 → `weight_configs` 테이블 INSERT (is_active=false)
- "활성화" 클릭 → 기존 active 비활성화 후 새 버전 활성화 (트랜잭션)
- **다음 파이프라인 실행부터 새 가중치 적용**
- 과거 버전 비교 뷰 (선택 기능)

#### `/backtest` — 백테스트 (admin only)

```
┌─────────────────────────────────────────────────────────────┐
│ 백테스트 설정                                                 │
├─────────────────────────────────────────────────────────────┤
│ 기간: [2025-11-01] ~ [2026-04-30]                            │
│ 가중치 버전: [v1.2 (active) ▼]                               │
│ 전략: ◉ score ≥ 0.65   ○ 강한 관심만   ○ 커스텀             │
│ 손절/익절: 익절 [+3%] 손절 [-2%]                              │
│                                              [실행] [취소]   │
├─────────────────────────────────────────────────────────────┤
│ 진행 상황: ████████████░░░░ 75%                              │
│ (GitHub Actions Runner에서 실행 중...)                        │
│ 로그 보기: https://github.com/.../actions/runs/123456         │
└─────────────────────────────────────────────────────────────┘
```

실행 흐름:
1. 웹 → `apps/api/backtest/start` POST → backtest_jobs 테이블에 'queued' INSERT
2. apps/api가 GitHub workflow_dispatch API 호출 → backtest.yml 트리거
3. GitHub Actions Runner가 signal/backtest.py 실행 → 진행률 backtest_jobs.progress 업데이트
4. 웹은 폴링 또는 Supabase Realtime으로 backtest_jobs 추적
5. 완료 시 결과 PNG/HTML이 Storage에 업로드 → 결과 페이지로 자동 이동

결과 페이지:
- 누적 수익률 그래프 (vs KOSPI) — Recharts LineChart
- Calibration plot — Recharts ScatterChart
- 신호별 승률 막대 — Recharts BarChart
- 섹터별 성과 — Recharts BarChart
- 일별 거래 내역 테이블
- [PDF 다운로드] (Storage signed URL)

#### `/admin/users` — 사용자 관리

- 사용자 목록 테이블: email, role, telegram 연동 여부, 마지막 로그인, 가입일
- 행 액션: [역할 변경] [비활성화] [텔레그램 강제 해제]
- 상단 **[+ 베타 초대]** → Modal: 이메일 입력 → invite_code 생성 → 이메일 발송 (Supabase Auth 또는 Resend)

#### `/admin/data-quality` — 데이터 품질 대시보드

- 일별 카드 (지난 14일):
  - 수집 성공률 (50종목 중 N개)
  - 정제 폐기율 (목표 14~15%)
  - LLM 호출 횟수 + 비용 추정 USD
  - 알림 발송 성공/실패
- 차트:
  - 일별 캐시 적중률 (LineChart)
  - 출처별 신뢰도 점수 (BarChart)
- 최근 에러 로그 (테이블)

#### `/admin/notifications` — 알림 로그

- 발송 이력 테이블 (날짜, 채널, 수신자, 상태)
- DRY_RUN 미리보기: 오늘 발송될 메시지를 채팅 풍선 형태로 미리 표시
- "지금 발송" 버튼 (수동 트리거)

#### `/settings` — 텔레그램 연동

```
┌─────────────────────────────────────────────────────────────┐
│ 텔레그램 연동                                                 │
├─────────────────────────────────────────────────────────────┤
│ 상태: ⚪ 미연동                                              │
│                                                              │
│ 1. 텔레그램에서 @QuantSignalBot 검색                          │
│ 2. 봇과 대화 시작 후 다음 명령어 입력:                         │
│                                                              │
│    /link 837456                                              │
│                                                              │
│    이 코드는 5분간 유효합니다. (남은 시간: 4:32)              │
│                                              [코드 재발급]   │
├─────────────────────────────────────────────────────────────┤
│ 알림 설정 (연동 후)                                          │
│ ☑ 일일 프리뷰 (06:30 KST)                                    │
│ ☑ 위험 신호 즉시 알림                                        │
│ ☐ 백테스트 완료 알림 (admin)                                  │
└─────────────────────────────────────────────────────────────┘
```

### 12-3. Supabase Auth 통합

**가입 흐름:**

| 권한 | 흐름 |
|---|---|
| admin | Supabase Dashboard → Authentication → Users → 운영자 이메일에 magic link → 가입 완료 후 SQL Editor에서 `UPDATE profiles SET role='admin' WHERE id=...` |
| beta | admin이 `/admin/users` → [+ 베타 초대] → invite_code 발급 → 이메일 발송 → 사용자가 `/invite/[token]`에서 가입 |
| user | (Phase 2) `/login`에 회원가입 폼 노출 → 이메일 인증 → role='user' 자동 설정 |

**Next.js 미들웨어 (`apps/web/middleware.ts`):**

```typescript
import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

const ADMIN_PATHS = ['/mapping', '/knowledge', '/weights', '/backtest', '/admin']

export async function middleware(request: NextRequest) {
  const supabase = createServerClient(/* ... */)
  const { data: { user } } = await supabase.auth.getUser()
  
  // 인증 체크
  if (!user && !request.nextUrl.pathname.startsWith('/login')) {
    return NextResponse.redirect(new URL('/login', request.url))
  }
  
  // admin 권한 체크
  if (ADMIN_PATHS.some(p => request.nextUrl.pathname.startsWith(p))) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single()
    
    if (profile?.role !== 'admin') {
      return NextResponse.redirect(new URL('/dashboard', request.url))
    }
  }
  
  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public).*)'],
}
```

### 12-4. RLS 정책 (모든 사용자 데이터 테이블)

```sql
-- profiles
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_profile"
  ON profiles FOR SELECT USING (auth.uid() = id);

CREATE POLICY "users_update_own_profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "admin_read_all_profiles"
  ON profiles FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- user_watchlists
ALTER TABLE user_watchlists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_manage_own_watchlist"
  ON user_watchlists FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 시장 데이터: 인증된 사용자 모두 read 가능
ALTER TABLE ai_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated_read_scores"
  ON ai_scores FOR SELECT TO authenticated USING (true);

-- mapping, weights: admin만 쓰기, 모든 인증 사용자 읽기
ALTER TABLE us_kr_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_read_mapping" ON us_kr_mapping FOR SELECT TO authenticated USING (true);
CREATE POLICY "admin_write_mapping" ON us_kr_mapping FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- audit_logs: admin만 read, 시스템(service_role)이 write
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admin_read_audit"
  ON audit_logs FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
```

### 12-5. Telegram ↔ Web App 연동 흐름

```
[웹앱]                          [텔레그램]
   │                               │
   │ /settings 클릭                │
   │ "코드 발급" 클릭              │
   │ ─→ profiles.telegram_link_code │
   │      = '837456'              │
   │      expires_at = NOW() + 5m │
   │                               │
   │ 화면에 "/link 837456" 표시    │
   │                               │
   │                               │ 사용자가 봇에게 입력:
   │                               │ /link 837456
   │                               │
   │  apps/api/telegram_webhook    │
   │  ←─ Update with command       │
   │                               │
   │  코드 검증:                    │
   │   1. profiles에서 link_code 조회│
   │   2. expires_at 확인           │
   │   3. 일치 시 telegram_chat_id  │
   │      업데이트, link_code 삭제   │
   │                               │
   │                               │ "✅ 연동 완료! 내일 06:30부터
   │                               │   프리뷰가 발송됩니다."
   │                               │
   │ 웹앱 새로고침 → 상태: 🟢 연동됨│
   ↓                               ↓
```

### 12-6. Server Component 데이터 페칭 패턴

```typescript
// app/(app)/dashboard/page.tsx
import { createClient } from '@/lib/supabase/server'

export default async function DashboardPage() {
  const supabase = await createClient()
  const today = new Date().toISOString().split('T')[0]
  
  // 병렬 페치
  const [{ data: scores }, { data: globalMarket }, { data: profile }] = 
    await Promise.all([
      supabase.from('ai_scores')
        .select('*, stocks(name, sector)')
        .eq('date', today)
        .order('final_score', { ascending: false })
        .limit(5),
      supabase.from('global_market')
        .select('*')
        .eq('date', today)
        .in('symbol', ['^IXIC', '^GSPC', '^SOX', '^VIX']),
      supabase.from('profiles')
        .select('*')
        .eq('id', (await supabase.auth.getUser()).data.user!.id)
        .single(),
    ])
  
  return <DashboardView scores={scores} market={globalMarket} profile={profile} />
}
```

### 12-7. apps/api/ 라우트 (Web App에서 호출)

가벼운 작업만 (Vercel 60초 한계). 무거운 작업은 GitHub workflow_dispatch로 위임 (SKILL.md 11-3 패턴).

```python
# apps/api/routes/web.py
import os, uuid, httpx
from fastapi import APIRouter, Depends, HTTPException
from .auth import get_current_admin

router = APIRouter(prefix="/api")

@router.post("/backtest/start")
async def start_backtest(req: BacktestRequest, user = Depends(get_current_admin)):
    job_id = str(uuid.uuid4())
    
    # 1. backtest_jobs 테이블에 INSERT (status=queued)
    sb.table("backtest_jobs").insert({
        "id": job_id, "status": "queued",
        "params": req.dict(), "created_by": user.id,
    }).execute()
    
    # 2. GitHub workflow_dispatch로 backtest.yml 트리거
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.github.com/repos/{os.environ['GITHUB_REPO']}/actions/workflows/backtest.yml/dispatches",
            headers={"Authorization": f"Bearer {os.environ['GITHUB_PAT']}"},
            json={"ref": "main", "inputs": {
                "job_id": job_id,
                "start_date": req.start_date,
                "end_date": req.end_date,
                "strategy": req.strategy,
                "weight_config_id": req.weight_config_id or "",
            }},
        )
    
    return {"job_id": job_id, "status": "queued"}

@router.get("/backtest/{job_id}/status")
async def backtest_status(job_id: str, user = Depends(get_current_admin)):
    # backtest_jobs 테이블에서 조회 (GitHub Actions Runner가 주기적으로 업데이트)
    result = sb.table("backtest_jobs").select("*").eq("id", job_id).single().execute()
    return result.data

@router.post("/knowledge/{chunk_id}/regenerate-embedding")
async def regenerate_embedding(chunk_id: str, user = Depends(get_current_admin)):
    # 작은 작업이라 Vercel에서 직접 처리 가능 (~2초)
    chunk = sb.table("rag_chunks").select("body").eq("id", chunk_id).single().execute()
    embedding = await get_embedding(chunk.data["body"])
    sb.table("rag_chunks").update({"embedding": embedding}).eq("id", chunk_id).execute()
    return {"ok": True}

@router.get("/notifications/preview-today")
async def preview_today(user = Depends(get_current_admin)):
    # 오늘 ai_scores 조회 → Telegram 메시지 포맷팅 → JSON 반환 (실제 발송 X)
    ...
```

### 12-8. 디자인 시스템 (KinderBoard·MeetFlow 패턴 차용)

- **다크 테마 기본** (KinderBoard 스타일)
- **메인 색상**: 오렌지-퍼플 그라디언트 강조 (긍정 시그널), 빨강 (위험)
- **신호 색상 매핑**:
  - 강한 관심: emerald-500
  - 관심: blue-500
  - 관망: gray-500
  - 주의: amber-500
  - 위험: red-500
- **타이포그래피**: Pretendard (한글), JetBrains Mono (숫자·티커)
- **shadcn/ui 컴포넌트**: Button, Card, Dialog, Form, Input, Select, Slider, Table, Tabs, Toast
- **레퍼런스**: CentralFlow CRM 스타일 (사이드바 + 메인 영역, 깔끔한 헤더)

---

*Last updated: 2026-05-05*
