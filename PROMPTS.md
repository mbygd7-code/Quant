# QuantSignal — Sequential Claude Code Prompts

> 이 파일은 Claude Code에 순서대로 입력할 프롬프트 모음.
> **한 프롬프트 = 한 세션 = 한 모듈**.
> 각 프롬프트는 6단계 인간 확인 프로토콜(Plan → Confirm → Code → Test → Review → Commit)을 따른다.
>
> 사용법: 각 prompt 블록을 그대로 복사해서 Claude Code에 붙여넣기.

---

## 사전 준비 (Prompt 01 시작 전 사용자 직접 수행)

**A. Supabase 프로젝트 생성**
1. https://supabase.com 접속 → New Project
2. Region: **Northeast Asia (Seoul)** 권장
3. Database Password 안전하게 보관
4. 프로젝트 생성 완료 후:
   - Settings → API → URL, anon public key, service_role key 복사
   - Settings → Database → Connection string의 password 복사
5. Database → Extensions → 'vector' 검색해 활성화
6. Storage → 다음 3개 버킷 생성 (모두 **Private**):
   - `raw-api-backups`
   - `backtest-reports`
   - `daily-reports`
7. Supabase CLI 설치: `brew install supabase/tap/supabase`
8. Account → Access Tokens → 새 토큰 발급 (GitHub Actions migration용)

**B. Telegram 봇 발급**
1. 텔레그램에서 @BotFather 검색 → /newbot → 봇 이름·username 입력 → BOT_TOKEN 복사
2. 본인이 만든 봇과 1:1 대화 시작 → /start 보내기
3. https://api.telegram.org/bot<TOKEN>/getUpdates 호출 → chat.id 숫자 복사
4. Webhook secret 생성: `python -c "import secrets; print(secrets.token_urlsafe(24))"` → TELEGRAM_WEBHOOK_SECRET

**C. API 키 발급**
- Anthropic API key (https://console.anthropic.com)
- OpenAI API key (https://platform.openai.com)
- Finnhub API key (https://finnhub.io, free tier OK)
- DART API key (https://opendart.fss.or.kr)
- Alpha Vantage API key (https://www.alphavantage.co/support/#api-key, free tier OK)
  * 용도: (1) Claude Code 로컬 개발 시 MCP 클라이언트로 활용 (선택)
          (2) 환율·거시 지표 보조 수집 (Phase 2, 선택)
  * MVP 배치 파이프라인에서는 사용하지 않음 (Finnhub로 대체 가능)

**D. GitHub 저장소 생성**
1. github.com → New repository → 이름 `quant-signal` (private 권장)
2. 로컬에서:
   ```
   git init
   git remote add origin https://github.com/<user>/quant-signal.git
   git checkout -b main
   ```
3. GitHub Settings → Secrets and variables → Actions에 등록:
   - `SUPABASE_PROJECT_REF` (프로젝트 URL의 서브도메인)
   - `SUPABASE_ACCESS_TOKEN` (위 A-8 단계에서 발급)
   - `SUPABASE_DB_PASSWORD`

**E. Vercel 가입**
1. https://vercel.com 가입 (GitHub 계정 연동 권장)
2. New Project → 위에서 만든 GitHub 저장소 선택
3. **Root Directory 설정 = `apps/web`** (Next.js 14 자동 감지됨)
4. Environment Variables 탭에 `.env.example` 키 입력 (Supabase + Anthropic + OpenAI + Telegram + GitHub PAT)
5. Build Output Settings는 기본값 (`apps/web/.next`)

**F. GitHub Personal Access Token (백테스트 트리거용)**
1. GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. New token:
   - Repository access: `quant-signal` repo만
   - Permissions: Actions (Read and write), Contents (Read), Metadata (Read)
3. 발급된 토큰을 Vercel Variables의 `GITHUB_PAT`에 등록
4. Vercel Variables에 `GITHUB_REPO=<owner>/quant-signal` 도 등록

**(Railway 미사용)** — 본 프로젝트는 Vercel + GitHub Actions만 사용. Railway는 추후 필요 시 별도 도입.

이 6개가 모두 끝났는지 확인하고 Prompt 01 시작.

---

## Prompt 01 — Project Bootstrap (Supabase + GitHub + Vercel)

```
CLAUDE.md와 SKILL.md를 정독하고, 다음을 수행해줘.
이 프로젝트는 Supabase를 DB/Auth/Storage 레이어로 사용하고,
GitHub monorepo에서 Vercel(웹+API) + GitHub Actions(워커·스케줄)로 분리 실행한다.
Railway는 사용하지 않는다 (추후 시나리오 도래 시에만).

[사전 안내 — 사용자에게 공지]
PROMPTS.md 사전 준비 A~F 6단계가 모두 완료되었는지 사용자에게 확인받고 진행할 것.
특히:
- Supabase 프로젝트 생성 + Storage 버킷 3개 + vector extension 활성화
- Telegram 봇 발급 + 본인 chat_id 확인 + Webhook secret 생성
- API 키 4개 발급 (Anthropic, OpenAI, Finnhub, DART)
- GitHub 저장소 생성 + Secrets 등록 (Supabase + AI + Telegram + Data 키 전체)
- Vercel 프로젝트 연결 (Root Directory = apps/web)
- GitHub Personal Access Token 발급 (apps/api에서 workflow_dispatch 호출용)

[작업 1] 프로젝트 폴더 구조 (CLAUDE.md 6번 그대로)
collectors/, refinery/, cognition/, signal/, executor/,
orchestrator/, notifier/, db/, apps/api/, apps/web/, tests/
+ supabase/migrations/  (Supabase CLI 표준)
+ supabase/seed/        (시드 데이터 SQL)
+ .github/workflows/    (4개 워크플로우 — ci, migrate, daily-pipeline, backtest)
각 Python 폴더에 빈 __init__.py 추가
apps/web/은 Prompt 13에서 Next.js 스캐폴드로 채울 예정 (이 단계에선 빈 폴더 + .gitkeep)

[작업 2] Supabase CLI 설정
- supabase/config.toml: Supabase CLI 표준
- README.md에 가이드:
  * `supabase init` 후 link
  * `supabase link --project-ref <ref>`
  * 마이그레이션은 GitHub Actions가 자동 처리

[작업 3] 마이그레이션 파일 생성
supabase/migrations/00000000000001_extensions.sql:
  CREATE EXTENSION IF NOT EXISTS vector;

supabase/migrations/00000000000002_core_tables.sql:
  SKILL.md 2-1번의 9개 핵심 테이블 + 인덱스
  (stocks, us_kr_mapping, korea_market, global_market, news_items, 
   filings, ai_scores, predictions, backtest_results, rag_chunks, notifications)

supabase/migrations/00000000000003_executor_tables.sql:
  paper_trades, paper_portfolio, backtest_jobs

supabase/migrations/00000000000004_user_tables.sql:
  SKILL.md 2-1번 후반부 — 웹앱용 테이블:
  profiles, user_watchlists, invite_codes, user_feedback,
  weight_configs, audit_logs

supabase/migrations/00000000000005_rls_policies.sql:
  - 시장 데이터: RLS enable, 인증 사용자 read 가능
  - 사용자 데이터: SKILL.md 12-4번 정책 그대로
  - mapping/weights: admin write, authenticated read
  - audit_logs: admin only

supabase/migrations/00000000000006_rpc_functions.sql:
  - match_rag_chunks (SKILL.md 10-2번)
  - match_news_embeddings
  - link_telegram(p_user_id uuid, p_link_code varchar) — 코드 검증 + chat_id 업데이트

supabase/migrations/00000000000007_triggers.sql:
  - profiles auto-create on auth.users INSERT (handle_new_user 함수)
  - audit_logs auto-insert trigger (선택)

supabase/migrations/00000000000008_seed_weight_config.sql:
  - 기본 weight_configs v1.0 활성화 (SKILL.md 3번 기본값)

[작업 4] 시드 데이터
supabase/seed/01_stocks.sql: 50종목 + 미국 매핑용 종목 INSERT
supabase/seed/02_us_kr_mapping.sql: SKILL.md 4번 매핑 INSERT

[작업 5] 공유 모듈
db/supabase_client.py: SKILL.md 10-1번
db/storage_client.py: 3개 버킷 업로드 헬퍼 + signed URL

[작업 6] 두 가지 배포 진입점

Vercel용 (apps/api/):
  apps/api/index.py:           # FastAPI app + Mangum handler
    - GET /health
    - POST /telegram/webhook   # 시크릿 토큰 검증 후 update 처리
    - GET /admin/data-quality
    - GET /admin/cost
    - POST /api/backtest/start # GitHub workflow_dispatch 호출
    - 내부에서 무거운 모듈 import 금지 (sklearn, pykrx 등)
  apps/api/requirements.txt:    # 가벼운 의존성만 (SKILL.md 11-2)
  apps/api/__init__.py

Pipeline 진입점 (저장소 루트, GitHub Actions가 호출):
  orchestrator/pipeline.py:
    - argparse: --mode={once} --date={YYYY-MM-DD|today}
    - --mode=once: 단일 실행 후 종료 (GitHub Actions가 매일 호출)
    - 로컬 개발용 daemon 모드는 만들지 않음 (GitHub Actions 사용)

[작업 7] 배포 설정 파일

vercel.json (저장소 루트): SKILL.md 11-2번 그대로

.github/workflows/ 디렉토리에 4개 워크플로우:
  1. ci.yml             — SKILL.md 11-5번 (Python lint/test + TS lint/typecheck)
  2. migrate.yml        — SKILL.md 11-5번 (supabase db push)
  3. daily-pipeline.yml — SKILL.md 11-3번 (매일 06:00 KST cron + workflow_dispatch)
  4. backtest.yml       — SKILL.md 11-3번 (workflow_dispatch only, apps/api에서 호출)

(Railway 관련 파일 — Dockerfile.worker, railway.toml — 만들지 않음)

[작업 8] .env.example, .gitignore
.env.example: SKILL.md 9번 그대로
.gitignore: SKILL.md 11-7번 그대로

[작업 9] pyproject.toml
의존성 분리:
  [project]
  dependencies = [        # GitHub Actions Runner가 사용 (전체)
    "supabase>=2.7",
    "psycopg[binary]>=3.2",
    "redis>=5",
    "anthropic",
    "openai",
    "pykrx",
    "finnhub-python",
    "edgartools",
    "scikit-learn",
    "apscheduler",
    "rapidfuzz",
    "python-telegram-bot[ext]>=21",
    "tenacity",
    "httpx",
    "pyyaml",
    "pydantic>=2",
    "fastapi",  # apps/api도 같은 코드 import
  ]
  [project.optional-dependencies]
  dev = ["pytest", "ruff", "mypy"]

apps/api/requirements.txt: Vercel 한정 가벼운 셋 (SKILL.md 11-2)

[작업 10] README.md
프로젝트 개요 + 다음 순서로 가이드:
1. Supabase 프로젝트 생성 (사전 준비 A)
2. Telegram 봇 발급 (사전 준비 B)
3. API 키 발급 (사전 준비 C)
4. GitHub 저장소 + Secrets 등록 (사전 준비 D)
5. Vercel 연결 (사전 준비 E)
6. GitHub PAT 발급 (사전 준비 F)
7. 로컬 개발:
   - `supabase link --project-ref ...`
   - `supabase db push`
   - SQL Editor에서 seed/*.sql 실행
   - `cp .env.example .env` 후 키 입력
   - `python -m notifier.bot_runner` (로컬 polling 테스트)
   - `python -m orchestrator.pipeline --mode=once --date=YYYY-MM-DD` (수동 실행)
8. 운영:
   - main branch에 push → Vercel 자동 배포 + Supabase 마이그레이션 자동 적용
   - GitHub Actions의 daily-pipeline.yml이 매일 06:00 KST 자동 실행
   - 수동 트리거: GitHub Actions 탭 → Daily Pipeline → Run workflow
   - Telegram Webhook 등록 (Vercel 배포 후 1회): SKILL.md 11-4번 curl 명령

[작업 11] 첫 커밋 준비
.gitkeep 빈 파일을 비어있는 폴더에 추가 (Git이 추적하도록):
  collectors/_raw/.gitkeep, logs/.gitkeep 등

CHANGELOG.md 빈 템플릿 생성

[순서]
1. 폴더 트리만 print → 사용자 승인
2. 사전 준비 6단계 완료 여부 사용자 확인
3. 파일 생성 (작업 1~11 순서)
4. 마지막에 첫 커밋 메시지 제안:
   "feat: bootstrap project with supabase + vercel + github actions scaffold"

6단계 프로토콜(Plan→Confirm→Code→Test→Review→Commit) 엄격히 지킬 것.
```

---

## Prompt 02 — Collectors: KRX + Finnhub

```
CLAUDE.md와 SKILL.md를 다시 읽고 collectors/ 모듈을 작성해줘.

[목표]
- collectors/krx.py: 관심 50종목 OHLCV + 외국인/기관 수급 (pykrx SDK)
- collectors/finnhub.py: 글로벌 주가 + 지수 + FX + 뉴스 (finnhub-python SDK)

(MCP 미사용 — CLAUDE.md I항 참조. 배치 수집은 결정론적·재현 가능해야 하므로 SDK 직접 호출.)

[요구사항]
1. 모든 collector는 Pydantic v2 모델로 검증된 데이터만 반환
   - collectors/__schemas__/korea.py: KoreaQuote, KoreaSupplyDemand
   - collectors/__schemas__/global.py: GlobalQuote, GlobalNews

2. 실패 처리:
   - tenacity retry 3회 (exponential backoff)
   - 3회 실패 시 dead letter queue (DB 또는 파일 로그)
   - 부분 실패는 허용 (50종목 중 47종목 성공이면 진행)

3. Finnhub 수집 대상:
   - 지수: ^IXIC, ^GSPC, ^SOX, ^DJI, ^RUT, ^VIX
   - FX: USDKRW, DXY
   - 종목: NVDA, AMD, MU, TSM, ASML, TSLA, RIVN, F, GM, AAPL, MSFT, GOOGL, META, LLY, MRK, PFE, NVO
   - 뉴스: 위 종목들의 company news (최근 24시간)

4. 호출 한계 준수:
   - Finnhub free tier: 60 calls/min → asyncio.Semaphore + rate limit
   - KRX: 일 10,000 → 캐시 적극 활용

5. 출력:
   - 각 collector는 fetch() 메서드로 List[Pydantic Model] 반환
   - DB 적재는 하지 않음 (refinery 통과 후 별도)
   - 단, raw JSON은 Supabase Storage `raw-api-backups/{YYYY-MM-DD}/{source}.json`에 백업
     (db/storage_client.py의 upload_raw 사용)

6. tests/test_collectors.py:
   - mock httpx로 정상/오류 케이스
   - Pydantic 검증 실패 시 폐기 확인

먼저 Plan으로 클래스 설계 보여주고, OK 받으면 코드.
```

---

## Prompt 03 — Refinery (PDF 7p 핵심)

```
refinery/ 모듈 4개 작성. PDF 7페이지의 14.45% 오류율을 방어하는 핵심 레이어.

[모듈]
1. refinery/validator.py
   - Pydantic 스키마 재검증 (collectors에서 통과했어도 다시 검증)
   - 필수 필드 누락 → 폐기
   - 타입 불일치 → 폐기

2. refinery/normalizer.py
   - 날짜: 모든 형식 → "YYYY-MM-DD" (KST 기준)
   - 티커: 한국 6자리 zero-pad, 미국 대문자
   - 통화: KRW만 허용 (USD는 별도 컬럼)
   - 결측값: NULL 유지 (절대 0 또는 평균으로 보정 금지)

3. refinery/deduplicator.py
   - 뉴스: rapidfuzz.ratio(title) > 85 → 동일 뉴스
   - 가격: (date, ticker) 중복 시 최신 timestamp 채택
   - 공시: (date, company, filing_type) 중복 제거

4. refinery/outlier.py
   - 가격 이상치: rolling 30일 z-score |z| > 4 → 폐기
   - 거래량 0: 거래정지 의심 → 별도 플래그
   - 뉴스: 제목 길이 < 10자 또는 > 500자 → 폐기

5. refinery/reliability.py
   - 출처별 신뢰도 점수 (KRX=1.0, Finnhub=0.95, 일반 뉴스=0.7)
   - 점수는 news_items.metadata에 저장

[테스트 — 가장 중요]
tests/test_refinery.py
- 의도적 오류 데이터 생성 fixture (100건):
  * 30건: 정상
  * 14건: Pydantic 검증 실패 (필드 누락, 타입 오류)
  * 15건: 정규화 후 중복
  * 10건: 가격 이상치 (z-score > 4)
  * 5건: 뉴스 제목 너무 짧음
  * 26건: 정상이지만 다른 필드에 미세 결함
- 파이프라인 통과 후 살아남는 데이터: 70±2건
- 폐기 데이터: 30±2건 (14.45% 가까이)

테스트 먼저 작성하고 (TDD), 그 다음 구현.
```

---

## Prompt 04 — Cognition: Sentiment Engine

```
cognition/sentiment.py 작성.

[요구사항]
1. 입력: refinery 통과 뉴스 1건 (title + body + related_symbols)

2. Claude API 호출 (model="claude-sonnet-4-5" 또는 환경변수):
   - system prompt: 한국 주식 투자자 관점에서 뉴스 감성 분석
   - few-shot 3개:
     * 긍정: "Nvidia, AI 칩 수요 폭증으로 분기 매출 사상 최대" → 0.92, very_positive
     * 중립: "삼성전자, 정기 인사 발표" → 0.50, neutral
     * 부정: "미 연준, 금리 동결... 인하 기대 후퇴" → 0.25, negative
   - structured output (Pydantic):
     class SentimentResult(BaseModel):
         sentiment_score: float = Field(ge=0, le=1)
         sentiment_label: Literal['very_negative','negative','neutral','positive','very_positive']
         related_symbols: list[str]
         importance: Literal['low','medium','high']
         reasoning: str  # 1~2 문장

3. 캐시:
   - 키: hash(date + title)
   - Redis TTL: 7일
   - 캐시 적중 시 LLM 미호출
   - 결과는 Supabase `news_items` 테이블에 sentiment_score, sentiment_label, importance, embedding 업데이트
     (db/supabase_client.get_admin_client() 사용)

4. 배치 처리:
   - asyncio로 동시 5건 (API rate limit 고려)
   - 실패 시 retry 2회, 그래도 실패하면 해당 뉴스 skip + 로그

5. 비용 통제:
   - input 4k tokens, output 500 tokens 상한
   - 일일 호출 카운터 (Redis) — 200건 초과 시 자동 중단

[테스트]
tests/test_sentiment.py:
- mock anthropic client
- 동일 뉴스 3회 호출 → 분산 확인 (캐시 동작)
- structured output 파싱 실패 시 retry 동작 확인

[추가]
cognition/sentiment_cli.py:
- python -m cognition.sentiment_cli --date=2026-05-06
- 그 날 수집된 뉴스 일괄 처리 + 결과 DB 저장
```

---

## Prompt 05 — Cognition: Mapper + RAG

```
[Part A] cognition/mapper.py

us_kr_mapping 테이블을 활용해 미국 종목 신호를 한국 종목으로 번역.

함수 시그니처:
def calculate_related_us_score(kr_ticker: str, date: date) -> float:
    """
    1. us_kr_mapping에서 kr_ticker에 연결된 모든 us_symbol + impact_strength 조회
    2. 각 us_symbol의 전일 change_rate를 global_market에서 조회
    3. weighted score:
       score = sigmoid(Σ(change_rate × impact_strength) / Σ(impact_strength))
    4. 0.0 ~ 1.0 범위 정규화
    """

[Part B] cognition/rag/

1. cognition/rag/chunks/ 디렉토리에 초기 청크 25개 YAML로 작성:
   - 반도체 6개 (NVDA→HBM, MU 가이던스, SOX, ASML 장비, 삼성 파운드리, 메모리 사이클)
   - 2차전지 5개 (TSLA 인도량, 리튬 가격, 양극재, IRA, 중국 경쟁)
   - 자동차 5개 (USDKRW, 미국 판매, 전기차 전환, 현대 GBC, 부품주 사이클)
   - 바이오 4개 (FDA 승인, 임상 단계, 환율, NVO/LLY GLP-1)
   - 인터넷/AI 5개 (광고 매출, 클라우드, AI 서버, 게임 출시, IDC 수요)

   각 청크는 SKILL.md 7번 형식 그대로:
   topic, markets, sectors, related_tickers, trigger_conditions,
   positive_signal, risk_warning, body, historical_examples

2. cognition/rag/embedder.py:
   - OpenAI text-embedding-3-small
   - YAML body → 임베딩 → rag_chunks 테이블 저장
   - 배치 처리, 캐시

3. cognition/rag/retriever.py:
   def retrieve(query: str, ticker: str | None, top_k: int = 5) -> list[Chunk]:
       # SKILL.md 10-2번 match_rag_chunks RPC 함수 호출
       # supabase-py: sb.rpc("match_rag_chunks", {...}).execute()
       # ticker가 주어지면 filter_tickers 파라미터로 전달

[테스트]
tests/test_rag.py:
- 청크 25개 임베딩 적재
- 쿼리 "Nvidia 상승이 한국 반도체에 미치는 영향" → top 3 결과에 NVDA·SOX·HBM 청크 포함 확인
```

---

## Prompt 06 — Signal: Scorer + GBM

```
[Part A] cognition/scorer.py

SKILL.md 3번의 7요소 가중 공식 그대로 구현.

class StockScorer:
    def score(self, ticker: str, date: date) -> AIScore:
        # 1. 7개 sub_score 계산
        global_market_score = self._global_market(date)         # NASDAQ, SOX 가중
        sector_score = self._sector(ticker, date)               # 섹터 ETF 기준
        related_us_stock_score = mapper.calculate_related_us_score(ticker, date)
        news_sentiment_score = self._news(ticker, date)         # 관련 뉴스 가중평균
        fundamental_score = self._fundamental(ticker, date)     # 공시 (Phase 2: 0.5 고정)
        volume_flow_score = self._volume_flow(ticker, date)     # 외국인/기관 수급
        risk_penalty = self._risk(ticker, date)                 # 단기 과열, 변동성

        # 2. 가중 합산
        final = (
            0.20 * global_market_score
            + 0.20 * sector_score
            + 0.20 * related_us_stock_score
            + 0.15 * news_sentiment_score
            + 0.10 * fundamental_score
            + 0.10 * volume_flow_score
            - 0.05 * risk_penalty
        )

        # 3. 5단계 신호 매핑
        signal = self._to_signal(final)

        # 4. ai_scores 테이블 저장 + rationale_json 포함
        return AIScore(...)

각 _xxx 메서드는 0.0~1.0 사이 값 반환. 데이터 없으면 0.5 (중립).

[Part B] signal/gbm.py

scikit-learn GradientBoostingClassifier.

class GBMPredictor:
    def __init__(self, model_version: str = "v1"):
        self.model = GradientBoostingClassifier(
            n_estimators=200, max_depth=4, learning_rate=0.05,
            subsample=0.8, random_state=42
        )

    def build_features(self, ticker: str, date: date) -> np.array:
        # SKILL.md 8번의 14개 feature

    def train(self, start_date, end_date):
        # TimeSeriesSplit(n_splits=5)
        # 50종목 × 영업일 → train set
        # target: next_day_return >= 0.01

    def predict(self, ticker: str, date: date) -> Prediction:
        # prob_up, model_confidence (= predict_proba 기반)
        # expected_volatility, gap_risk는 룰 기반 (변동성 통계)

[테스트]
tests/test_scorer.py:
- 동일 (ticker, date) 3회 호출 → final_score 분산 < 0.01
- 모든 sub_score가 0.5일 때 final_score = 0.475 (정확한 산수)
- rationale_json에 근거 3개·리스크 2개 키 존재

tests/test_gbm.py:
- 더미 데이터로 학습/예측 동작
- predict_proba 합 = 1
```

---

## Prompt 07 — Signal: Report Generator + 금지어 검증

```
signal/report.py 작성.

[요구사항]
1. 입력: AIScore 객체 + 관련 RAG 청크 top 3 + 관련 뉴스 top 3

2. Claude API 호출:
   - system prompt: CLAUDE.md 3-A의 표현 규칙 그대로 주입
   - 출력 형식 (Pydantic):
     class StockReport(BaseModel):
         ticker: str
         signal: Literal['강한 관심','관심','관망','주의','위험']
         score: float
         positive_factors: list[str] = Field(min_length=3, max_length=3)
         risk_factors: list[str] = Field(min_length=2, max_length=2)
         comment: str  # 2~3 문장

3. 금지어 검증 hook:
   FORBIDDEN = ["매수", "매도", "강력 추천", "오늘 오른다", "확정", "보장", "100%"]

   def validate_report(report: StockReport):
       full_text = " ".join([
           report.comment, *report.positive_factors, *report.risk_factors
       ])
       for word in FORBIDDEN:
           if word in full_text:
               raise ForbiddenWordError(f"금지어 발견: {word}")

   금지어 발견 시 LLM 재호출 (최대 2회), 그래도 실패하면 해당 종목 skip.

4. 면책 문구 자동 추가:
   "※ 본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다."

5. signal/preview_report.py:
   - 50종목 전체에 대한 일일 요약 리포트
   - 섹터별 온도 (강한 관심/관심 종목 수)
   - 글로벌 온도 (Nasdaq, SOX, VIX 종합)
   - 상위 5종목 강조

[테스트]
tests/test_report.py:
- 금지어 포함 LLM 응답 → ForbiddenWordError raise 확인
- 정상 응답 → 면책 문구 자동 추가 확인
- positive_factors가 3개 미만이면 검증 실패

[Plan 단계 필수]
LLM 프롬프트 전체 텍스트를 보여주고 내 OK 받은 다음 진행.
```

---

## Prompt 08 — Notifier: Telegram Bot (Beta)

```
notifier/ 모듈 작성. SKILL.md 6번 포맷 그대로.
Beta 단계는 Telegram만 구현. Kakao는 인터페이스 stub만.

[사전 준비 — 사용자에게 안내]
1. Telegram BotFather(@BotFather)에서 봇 생성:
   - /newbot 명령 → 봇 이름·username 입력 → BOT_TOKEN 발급
2. 본인의 chat_id 확인:
   - 봇과 1:1 대화 시작 후 /start 보내기
   - https://api.telegram.org/bot<TOKEN>/getUpdates 호출 → chat.id 확인
3. .env에 TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS 입력

[Part A] notifier/telegram.py

라이브러리: python-telegram-bot v21+ (async)

class TelegramNotifier:
    def __init__(self, bot_token: str, chat_ids: list[str]):
        self.bot = Bot(token=bot_token)
        self.chat_ids = chat_ids
    
    async def send_preview(self, date: date, reports: list[StockReport]):
        """일일 프리뷰 — 글로벌 온도 + 섹터 + 상위 5종목 카드 + 인라인 키보드"""
        # SKILL.md 6-1번 형식
        # parse_mode=MarkdownV2
        # InlineKeyboardMarkup으로 [상세보기 / 다음 종목 / 섹터 요약] 버튼
    
    async def send_individual(self, chat_id: str, report: StockReport):
        """개별 종목 상세 카드"""
        # 긍정요인 3 + 리스크 2 + AI 코멘트
        # [관련 뉴스 / 이전 / 다음 / 메인으로] 버튼
    
    async def send_admin_alert(self, message: str, level: str = "info"):
        """운영자 알림 — 파이프라인 실패, 비용 초과 등"""
        # TELEGRAM_ADMIN_CHAT_ID로만 발송

class MarkdownV2Escaper:
    """SKILL.md 6-4번 이스케이프 함수"""
    @staticmethod
    def escape(text: str) -> str: ...

[Part B] notifier/telegram_handlers.py

명령어 핸들러 (python-telegram-bot Application):

async def cmd_start(update, context):
    """환영 메시지 + 사용 가이드"""

async def cmd_today(update, context):
    """오늘자 ai_scores 조회 → send_preview"""

async def cmd_stock(update, context):
    """/stock 005930 → 해당 종목 상세"""
    ticker = context.args[0]
    # ticker 검증 (50종목 watchlist 내인지)
    # 오늘자 report 조회 후 send_individual

async def cmd_sector(update, context):
    """/sector 반도체 → 해당 섹터 종목 요약"""

async def cmd_top(update, context):
    """final_score 상위 5종목"""

async def cmd_risk(update, context):
    """signal in ('주의','위험')인 종목만"""

async def cmd_help(update, context):
    """명령어 안내"""

async def callback_handler(update, context):
    """InlineKeyboard 콜백:
    - callback:detail:<ticker> → send_individual
    - callback:list_all → 50종목 페이지네이션
    - callback:by_sector → 섹터 선택 화면
    - callback:news:<ticker> → 관련 뉴스 top 3
    - callback:home → 프리뷰로 돌아가기
    """

[Part C] notifier/kakao.py (stub)

class KakaoNotifier:
    def __init__(self, *args, **kwargs):
        raise NotImplementedError(
            "카카오 알림톡은 Phase 2입니다. "
            "사업자 등록 + 템플릿 승인 후 별도 세션에서 구현하세요."
        )

[Part D] notifier/dispatcher.py

class NotificationDispatcher:
    def __init__(self):
        channels = os.getenv("NOTIFY_CHANNELS", "telegram").split(",")
        self.notifiers = []
        if "telegram" in channels:
            self.notifiers.append(TelegramNotifier(...))
        if "kakao" in channels:
            self.notifiers.append(KakaoNotifier(...))  # Phase 2
    
    async def dispatch(self, date: date, reports: list[StockReport]):
        for notifier in self.notifiers:
            try:
                await notifier.send_preview(date, reports)
                # notifications 테이블에 status='sent' 기록
            except Exception as e:
                # 운영자 admin_alert 발송
                # status='failed' 기록
                # Telegram은 retry 3회 (rate limit 시 backoff)

[Part E] notifier/bot_runner.py (로컬 개발용 Polling)

봇 polling 실행 진입점:

async def run_bot():
    """python -m notifier.bot_runner
    
    [용도] 로컬 개발 시에만 사용. Vercel 운영 환경에서는 webhook으로 처리.
    
    텔레그램 봇을 polling 모드로 실행.
    명령어 + 콜백 핸들러 등록.
    """
    application = Application.builder().token(BOT_TOKEN).build()
    application.add_handler(CommandHandler("start", cmd_start))
    application.add_handler(CommandHandler("today", cmd_today))
    application.add_handler(CommandHandler("stock", cmd_stock))
    application.add_handler(CommandHandler("sector", cmd_sector))
    application.add_handler(CommandHandler("top", cmd_top))
    application.add_handler(CommandHandler("risk", cmd_risk))
    application.add_handler(CommandHandler("help", cmd_help))
    application.add_handler(CallbackQueryHandler(callback_handler))
    
    await application.run_polling()

[Part F] apps/api/routes/telegram_webhook.py (Vercel 운영용)

FastAPI 라우터로 webhook 처리. apps/api/index.py에서 import.

from fastapi import APIRouter, Request, Header, HTTPException
from telegram import Update
from telegram.ext import Application

router = APIRouter()
_application = None

async def get_application() -> Application:
    """싱글톤 application 인스턴스. Part E와 동일한 핸들러 등록."""
    global _application
    if _application is None:
        _application = Application.builder().token(BOT_TOKEN).build()
        _application.add_handler(CommandHandler("start", cmd_start))
        # ... 동일 핸들러 모두 등록
        await _application.initialize()
    return _application

@router.post("/telegram/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str = Header(None),
):
    # 1. Telegram의 secret token 검증
    if x_telegram_bot_api_secret_token != os.environ["TELEGRAM_WEBHOOK_SECRET"]:
        raise HTTPException(403, "Invalid secret token")
    
    # 2. Update 파싱 + 핸들러 실행
    data = await request.json()
    app = await get_application()
    update = Update.de_json(data, app.bot)
    await app.process_update(update)
    
    return {"ok": True}

[Part G] webhook 등록 스크립트 (수동 1회 실행)

scripts/setup_telegram_webhook.py:

import os
import httpx

def main():
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    webhook_url = os.environ["VERCEL_DEPLOYMENT_URL"] + "/telegram/webhook"
    secret = os.environ["TELEGRAM_WEBHOOK_SECRET"]
    
    r = httpx.post(
        f"https://api.telegram.org/bot{token}/setWebhook",
        json={
            "url": webhook_url,
            "secret_token": secret,
            "allowed_updates": ["message", "callback_query"],
        },
    )
    print(r.json())

if __name__ == "__main__":
    main()

# 사용:
# Vercel 첫 배포 후:
# VERCEL_DEPLOYMENT_URL=https://quant-signal.vercel.app \
#   python scripts/setup_telegram_webhook.py

[중요 — 발송 안전장치]
- DRY_RUN=true면 실제 발송 안 하고 메시지를 logs/telegram_preview_{date}.txt에 저장
- 신호가 "위험"인 종목은 메시지 상단에 ⚠️ 강조
- 일일 프리뷰는 채팅별 1회만 (notifications 테이블로 중복 체크)
- MarkdownV2 이스케이프 누락 → 텔레그램이 400 에러 → 자동으로 plain text로 fallback
- 메시지 크기 4096자 초과 시 자동 분할

[테스트]
tests/test_notifier.py:
- mock telegram Bot
- MarkdownV2Escaper: 모든 특수문자 이스케이프 검증
  ("hello.world!" → "hello\\.world\\!")
- send_preview 호출 시 InlineKeyboardMarkup 구조 검증
- DRY_RUN 모드 — 파일 출력 확인
- KakaoNotifier 인스턴스화 시 NotImplementedError 확인
- callback_handler — "callback:detail:005930" 파싱 확인
- 메시지 4096자 초과 → 분할 발송 확인
- webhook secret token 검증 (틀린 토큰 → 403)

[Plan 단계 필수]
1. 봇 명령어 + 콜백 라우팅 표를 보여주고 OK 받기
2. MarkdownV2 샘플 메시지를 실제 텔레그램에 발송해서 렌더링 확인
3. 로컬 polling vs Vercel webhook 어느 모드로 테스트할지 사용자에게 확인
```

---

## Prompt 09 — Executor Interface (Phase 3 대비)

```
executor/ 모듈 작성. 지금은 PaperBroker만 구현, KIS/Kiwoom은 stub.

[Part A] executor/broker_interface.py

from abc import ABC, abstractmethod
from pydantic import BaseModel

class Order(BaseModel):
    ticker: str
    side: Literal['buy', 'sell']
    qty: int
    price: int | None  # None이면 시장가
    
class Position(BaseModel):
    ticker: str
    qty: int
    avg_price: int
    current_price: int
    unrealized_pnl: int

class BrokerInterface(ABC):
    @abstractmethod
    def get_balance(self) -> dict: ...
    @abstractmethod
    def place_order(self, order: Order) -> str: ...  # returns order_id
    @abstractmethod
    def get_positions(self) -> list[Position]: ...
    @abstractmethod
    def cancel_order(self, order_id: str): ...

[Part B] executor/paper_broker.py

class PaperBroker(BrokerInterface):
    """
    가상 매매 시뮬레이션.
    - 초기 자본 1,000만원
    - korea_market의 다음날 시가로 체결 가정
    - 거래 내역은 paper_trades 테이블에 저장 (Supabase 마이그레이션에 이미 정의됨)
    - 일별 포트폴리오 가치 계산
    """
    # 모든 메서드 구현
    # Supabase 접속: from db.supabase_client import get_admin_client

[Part C] executor/kis_broker.py + kiwoom_broker.py

class KISBroker(BrokerInterface):
    def __init__(self):
        raise NotImplementedError(
            "KIS 실거래 연동은 Phase 3입니다. "
            "사용자 명시적 승인 후 별도 세션에서 구현하세요."
        )

class KiwoomBroker(BrokerInterface):
    def __init__(self):
        raise NotImplementedError("Kiwoom 실거래 연동은 Phase 3입니다.")

[Part D] Supabase 마이그레이션 — 이미 Prompt 01에서 생성됨

paper_trades, paper_portfolio 테이블은
supabase/migrations/00000000000003_executor_tables.sql 에 이미 정의됨.

이 단계에서는 마이그레이션 추가 없이 스키마 존재 확인만:
  python -c "from db.supabase_client import get_admin_client; \
             c = get_admin_client(); \
             print(c.table('paper_trades').select('*').limit(0).execute())"

만약 테이블이 누락됐다면 Prompt 01의 마이그레이션 파일을 점검할 것.

[안전장치]
- EXECUTION_MODE 환경변수 검증:
  if os.getenv("EXECUTION_MODE") not in ("report_only", "paper"):
      raise SecurityError("MVP 단계에서는 report_only 또는 paper만 허용")

[테스트]
tests/test_executor.py:
- PaperBroker로 매수 → 다음날 시가 체결 확인
- KISBroker, KiwoomBroker 인스턴스화 시 NotImplementedError 확인
- EXECUTION_MODE=kis_real 설정 시 SecurityError 확인
```

---

## Prompt 10 — Orchestrator + Backtest

```
[Part A] orchestrator/pipeline.py

class DailyPipeline:
    def run(self, date: date):
        # 1. Acquisition (병렬)
        krx_data = await krx_collector.fetch(date)
        finnhub_data = await finnhub_collector.fetch(date)
        
        # 2. Refinement
        clean_korea = refinery.process(krx_data, schema=KoreaQuote)
        clean_global = refinery.process(finnhub_data, schema=GlobalQuote)
        
        # 3. Cognition
        sentiments = sentiment_engine.batch(news_items)
        
        # 4. Signal
        reports = []
        for ticker in WATCHLIST_50:
            score = scorer.score(ticker, date)
            chunks = rag.retrieve(ticker=ticker, top_k=3)
            news = get_recent_news(ticker, top_k=3)
            report = report_generator.generate(score, chunks, news)
            reports.append(report)
        
        # 5. Notify
        dispatcher.dispatch(date, reports)
        
        # 6. (Phase 2) Paper trading
        if os.getenv("EXECUTION_MODE") == "paper":
            paper_broker.execute_signals(reports)

[Part B] orchestrator/schedule.py

APScheduler:
- cron 06:00 KST 매일 (월~금)
- 미국 휴장일 / 한국 휴장일 처리 (휴장일 전후로 스킵 또는 부분 실행)
- 실패 시 운영자 Telegram 알림 (TELEGRAM_ADMIN_CHAT_ID로 send_admin_alert)

[Part C] signal/backtest.py

class Backtest:
    def run(self, start: date, end: date, strategy: str = "score_above_0.65"):
        """
        Walk-forward:
        - 매일 ai_scores 재계산
        - signal == "관심" 이상이면 가상 진입 (다음날 시가)
        - 1일 보유 후 다음날 시가 청산
        """
        # 결과:
        # - 일별 수익률
        # - 누적 수익률 vs KOSPI
        # - Sharpe ratio
        # - Max drawdown
        # - 신호별 승률
        # - 섹터별 성과
        # - Calibration plot (예측 확률 vs 실제 적중률)
        # → backtest_results 테이블 저장 + matplotlib PNG 출력

[Part D] apps/api/main.py (운영자용 Swagger UI)

FastAPI 엔드포인트:
- GET /health
- POST /pipeline/run?date=YYYY-MM-DD (수동 트리거)
- GET /reports/{date}
- GET /reports/{date}/{ticker}
- GET /backtest/run?start=...&end=...
- GET /admin/data-quality?date=... (오늘 정제 통계)
- GET /admin/cost?date=... (LLM 비용 통계)

[테스트]
tests/test_pipeline.py:
- mock 모든 외부 API
- 단일 날짜 end-to-end 실행
- 50종목 모두 리포트 생성 확인
- 알림 dispatcher 호출 확인 (DRY_RUN)

[배포 — 분리 배포 구조]

이 단계에서는 코드 통합만 한다. 실제 배포는 Prompt 11에서 GitHub push로 트리거.

orchestrator/run.py 두 가지 모드 지원:
  - --mode=once: 단일 파이프라인 1회 실행 후 종료 (GitHub Actions가 매일 호출)
  - --mode=daemon: APScheduler 백그라운드 실행 (Cron 미사용 시 fallback)

apps/api/index.py:
  - SKILL.md 11-2번 구조 그대로
  - /telegram/webhook 라우터 등록 (Prompt 08 Part F)
  - /admin/* 엔드포인트 등록
  - 무거운 모듈 import 절대 금지 (sklearn, pykrx 등)
  - DB 조회 결과만 가공해서 응답

로컬 검증:
  python -m orchestrator.run --mode=once --date=YYYY-MM-DD
  uvicorn apps.api.index:app --reload  (FastAPI 로컬 테스트)

[테스트]
tests/test_pipeline.py:
- mock 모든 외부 API (Supabase, Telegram, LLM)
- 단일 날짜 end-to-end 실행
- 50종목 모두 리포트 생성 확인

tests/test_api.py:
- FastAPI TestClient로 /health, /telegram/webhook, /admin/* 검증
- /telegram/webhook 시크릿 토큰 검증 (틀린 토큰 → 403)
```

---

## Prompt 11 — Deploy: GitHub + Vercel + GitHub Actions

```
배포 단계. 코드 변경 없이 설정 파일 검증 + 실제 배포 트리거 + 검증.

[사전 확인]
사용자에게 확인:
- GitHub 저장소 생성 + Secrets 등록 완료? (Supabase + AI + Telegram + Data 키 전부)
- Vercel 프로젝트 연결 + Root Directory = apps/web 설정 완료?
- GitHub PAT 발급 완료 + Vercel Variables에 GITHUB_PAT, GITHUB_REPO 등록 완료?
- Telegram Webhook secret이 GitHub Secrets에 등록됐는지?

[작업 1] 배포 설정 파일 최종 검증

vercel.json (저장소 루트):
  - rootDirectory: apps/web (Next.js)
  - functions에 apps/api/**/*.py 패턴 (maxDuration: 60)
  - rewrites: /api/* → apps/api/*

apps/api/requirements.txt:
  - 가벼운 의존성만 (SKILL.md 11-2번 목록 정확히)
  - sklearn, pykrx, edgartools 없는지 확인
  - 빌드 사이즈 시뮬레이션:
    pip install -t /tmp/test_size -r apps/api/requirements.txt
    du -sh /tmp/test_size  → 250MB 이하 확인

apps/web/package.json:
  - Next.js 14 + React 18 + Tailwind + shadcn/ui 의존성
  - npm run build 로컬 통과 확인

.github/workflows/ 4개 파일 검증:
  - ci.yml             → PR + push 시 lint + test
  - migrate.yml        → main + supabase/migrations/** 변경 시 supabase db push
  - daily-pipeline.yml → cron "0 21 * * 0-4" + workflow_dispatch
  - backtest.yml       → workflow_dispatch (apps/api에서 호출)

각 워크플로우 env 블록의 secrets 이름이 GitHub Secrets에 정확히 등록됐는지 매칭:
  GitHub Secrets 탭에서 다음 키 모두 존재 확인:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_PROJECT_REF, SUPABASE_ACCESS_TOKEN,
    SUPABASE_DB_PASSWORD, ANTHROPIC_API_KEY, OPENAI_API_KEY, FINNHUB_API_KEY,
    DART_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, TELEGRAM_WEBHOOK_SECRET

[작업 2] 첫 푸시 + 배포 트리거

git add .
git commit -m "feat: initial deployment setup with vercel + github actions"
git push origin main

이후 자동으로 발생하는 일들:
1. GitHub Actions ci.yml 실행 → 통과 확인 (Actions 탭)
2. GitHub Actions migrate.yml 실행 → Supabase 마이그레이션 적용 확인
3. Vercel이 자동 빌드 + 배포 → Vercel Dashboard에서 deployment URL 확인
   - apps/web (Next.js) 빌드 통과
   - apps/api (Python Functions) 빌드 통과

각 단계에서 실패하면 Plan 단계로 돌아가서 디버깅. 자동으로 다음 단계 진행 금지.

[작업 3] Telegram Webhook 등록 (Vercel 배포 완료 후 1회)

scripts/setup_telegram_webhook.py 실행:
  VERCEL_DEPLOYMENT_URL=https://<your-vercel-domain>.vercel.app \
    python scripts/setup_telegram_webhook.py

검증:
  curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
  → "url": "https://...vercel.app/api/telegram/webhook" 확인
  → "last_error_message": null 확인

텔레그램에서 본인이 만든 봇에게 /start 보내기 → 정상 응답 확인.

[작업 4] Daily Pipeline 첫 실행 검증

방법 1 — 수동 트리거:
  GitHub Actions 탭 → Daily Pipeline → Run workflow → date 비우고 Run
  
방법 2 — 다음날 06:00 KST 자동 실행 대기

검증:
  - Actions 로그에서 "수집 → 정제 → 인지 → 시그널 → 알림" 5단계 모두 통과
  - Supabase Dashboard에서 ai_scores 테이블 신규 INSERT 확인 (50건)
  - Telegram 등록된 chat_id로 프리뷰 메시지 도착 확인

문제 발생 시:
  - GitHub Secrets 누락 키 점검
  - Actions 로그에서 에러 trace 확인
  - Supabase Service Role Key 권한 점검
  - 외부 API 키 quota 점검 (Finnhub free tier rate limit 등)

[작업 5] 운영 시작 체크리스트

CHANGELOG.md에 v0.1.0 기록:
  - 50종목 watchlist 활성화
  - Telegram Bot beta 배포 (Webhook 방식)
  - Daily pipeline 06:00 KST cron 활성화 (GitHub Actions)
  - Paper Trading 모드 (실거래 비활성)
  - 웹앱 베타 (admin only)

운영 모니터링 채널:
  - GitHub Actions 탭 (파이프라인·백테스트 실행 이력 + 로그)
  - Vercel Dashboard (apps/web + apps/api 로그)
  - Supabase Dashboard (DB 사용량 + Storage 사용량 + Auth 사용자)
  - Telegram Admin Chat (오류 알림 — 워크플로우 실패 시 자동)
  - Anthropic/OpenAI Dashboard (LLM 비용 모니터링)

[Plan 단계 필수]
- 작업 2 push 전 보안 점검:
  * .env가 .gitignore에 있는지 확인
  * service_role key가 코드에 하드코딩되어 있지 않은지 grep:
      grep -rn "eyJh" --include="*.py" --include="*.ts" --include="*.tsx" .
    → 결과가 .env.example 외에 있으면 안 됨
  * TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY 등 모든 키가 코드에 직접 안 박혔는지 확인
- 작업 4 검증 전 Telegram 채팅에 본인 chat_id가 등록됐는지 (profiles 테이블 또는 GitHub Secrets)

[테스트]
배포 후 smoke test:
- curl https://<vercel>/api/health  → {"status":"ok"}
- 텔레그램 봇 /start, /help, /today, /stock 005930 명령어 모두 응답 확인
- GitHub Actions 수동 트리거 → 약 30분 후 Telegram 프리뷰 도착
- Vercel /dashboard 페이지 정상 렌더 (admin 로그인 후)
- Supabase Dashboard에서 ai_scores 테이블에 50건 INSERT 확인
```

---

## Prompt 12 — Post-Launch: Monitoring + Iteration

```
운영 시작 후 첫 2주간 수행할 모니터링 + 튜닝 작업.

[작업 1] 일일 운영 점검 자동화

orchestrator/health_check.py:
  매일 07:30 (파이프라인 종료 후) Telegram Admin에게 자동 발송:
  - 수집 성공률 (50종목 중 N개)
  - 정제 폐기율 (목표 14~15%)
  - LLM 호출 횟수 + 비용 추정
  - 알림 발송 성공 여부
  - 에러 카운트

.github/workflows/health-check.yml 추가:
  on:
    schedule:
      - cron: "30 22 * * 0-4"  # KST 07:30 (UTC 22:30 전날)
    workflow_dispatch:
  jobs:
    health-check:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-python@v5
          with: { python-version: "3.11", cache: pip }
        - run: pip install -e .
        - run: python -m orchestrator.health_check
          env:
            SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
            SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
            TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
            TELEGRAM_ADMIN_CHAT_ID: ${{ secrets.TELEGRAM_ADMIN_CHAT_ID }}

[작업 2] 백테스트 첫 결과 분석

signal/backtest.py:
  최근 6개월 데이터로 백테스트 1회 실행:
  python -m signal.backtest --start=2025-11-01 --end=2026-04-30 \
    --strategy=score_above_065

결과 PNG/HTML이 Supabase Storage backtest-reports/에 업로드됨.
운영자에게 signed URL로 Telegram 발송.

검토 지표:
  - 신호별 승률
  - 섹터별 성과
  - 코스피 대비 초과수익
  - Calibration plot (예측 확률 vs 실제 적중률)
  - 최대 낙폭 시점 분석

[작업 3] 7요소 가중치 튜닝 (필요 시)

만약 백테스트 결과가:
  - 글로벌 점수 영향 약하다 → 0.20 → 0.25
  - 뉴스 감성 노이즈 많다 → 0.15 → 0.10
  - 수급 점수 약하다 → 0.10 → 0.15

변경 시 반드시:
  1. SKILL.md 3번 공식 업데이트
  2. CHANGELOG.md에 변경 사유 기록
  3. supabase/migrations/에 마이그레이션 추가 (필요 시)
  4. 사용자 명시 승인 후 main branch push

[작업 4] 베타 테스터 추가

새 베타 테스터 합류 시 (Prompt 17의 /link 방식 사용):
  1. admin이 웹앱 /admin/users → [+ 베타 초대] → 이메일 입력
  2. 초대 이메일 수신 → /invite/[token]에서 가입
  3. 사용자가 /settings에서 [코드 발급] 클릭
  4. 텔레그램 봇에서 /link <6자리코드> 입력
  5. profiles.telegram_chat_id 자동 등록 → 다음날 06:30부터 프리뷰 수신

[작업 5] LLM 비용 모니터링

apps/api/admin/cost.py:
  - 일별 input/output 토큰 합계
  - Anthropic + OpenAI 추정 비용 (USD)
  - 캐시 적중률
  - 일일 200건 제한 대비 사용률

비용이 예상치 초과 시:
  - 캐시 TTL 늘리기 (7일 → 14일)
  - 뉴스 감성 분석을 일별 → 종목별 top 3 뉴스만으로 제한
  - 리포트 생성 모델을 Sonnet → Haiku로 다운그레이드 검토

[작업 6] 사용자 피드백 수집

베타 테스터에게 매주 금요일 텔레그램 폴 발송:
  /feedback 명령어 추가 (Prompt 08 핸들러에 추가):
  - 정확도: 1~5점
  - 유용성: 1~5점
  - 개선 사항 자유 텍스트

응답은 user_feedback 테이블에 저장.
주간 리포트로 운영자 Telegram 발송.
```

---

## Prompt 13 — Web App Bootstrap (Next.js + Auth)

```
apps/web/ 디렉토리에 Next.js 14 App Router 프로젝트 스캐폴드.
SKILL.md 12번 + CLAUDE.md G·H 항 엄격 준수.

[작업 1] Next.js 프로젝트 생성
cd apps/web
npx create-next-app@latest . \
  --typescript --tailwind --eslint --app \
  --src-dir=false --import-alias="@/*"

package.json은 SKILL.md 11-2번 그대로 (의존성 추가 설치)

[작업 2] shadcn/ui 초기화
npx shadcn-ui@latest init
  - Style: Default
  - Base color: Zinc
  - CSS variables: Yes (다크모드 지원)
npx shadcn-ui@latest add button card dialog form input label \
  select slider table tabs toast dropdown-menu sheet sonner badge

[작업 3] 폴더 구조 (SKILL.md 12-1번 그대로)
apps/web/
├── app/
│   ├── (auth)/login/page.tsx
│   ├── (auth)/invite/[token]/page.tsx
│   ├── (app)/layout.tsx
│   ├── (admin)/layout.tsx
│   ├── api/auth/callback/route.ts
│   └── layout.tsx
├── components/
│   ├── ui/                      # shadcn-ui (자동)
│   ├── layout/sidebar.tsx
│   ├── layout/header.tsx
│   └── auth/login-form.tsx
├── lib/
│   ├── supabase/client.ts
│   ├── supabase/server.ts
│   ├── supabase/middleware.ts
│   └── utils.ts
└── middleware.ts

[작업 4] Supabase 클라이언트 설정 (lib/supabase/)

client.ts:
  import { createBrowserClient } from '@supabase/ssr'
  export function createClient() {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
  }

server.ts:
  import { createServerClient } from '@supabase/ssr'
  import { cookies } from 'next/headers'
  export async function createClient() {
    const cookieStore = await cookies()
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll() },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) =>
                cookieStore.set(name, value, options)
              )
            } catch { /* Server Component */ }
          },
        },
      }
    )
  }

[작업 5] middleware.ts (SKILL.md 12-3번 그대로)
- 인증 체크 → /login 리디렉션
- /admin/*, /mapping, /knowledge, /weights, /backtest 권한 체크 → role='admin' 검증
- profiles 조회 결과 캐싱 (요청당 1회)

[작업 6] 로그인 페이지 (auth/login/page.tsx)
- Supabase Auth UI 또는 커스텀 폼
- Magic Link 방식 우선 (이메일만 입력 → 메일 확인)
- "초대 코드 있음" 토글 → /invite/[token] 안내
- 디자인: SKILL.md 12-8번 다크 테마 + 오렌지 그라디언트 강조

[작업 7] 초대 가입 페이지 (auth/invite/[token]/page.tsx)
- URL 토큰으로 invite_codes 조회 → 유효성 확인
- 만료/사용된 코드면 에러 메시지
- 유효하면 비밀번호 입력 → Supabase Auth signUp → invite_codes.used_at 업데이트
- profiles.role은 invite_codes.role(default 'beta')로 설정

[작업 8] 레이아웃 + 사이드바
(app)/layout.tsx:
  - 사용자 인증 확인
  - profiles 조회 → 사이드바에 권한별 메뉴 노출
  - 사이드바: Sidebar 컴포넌트 (shadcn Sheet on mobile)
  - 헤더: 알림 종, 다크/라이트 토글, 사용자 메뉴 (로그아웃 등)

(admin)/layout.tsx:
  - role !== 'admin'이면 /dashboard로 redirect
  - admin 전용 사이드바 메뉴 추가 표시

[작업 9] 환경 변수 (.env.local)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=     # Server Component에서만, 절대 NEXT_PUBLIC_ 금지
NEXT_PUBLIC_APP_URL=http://localhost:3000

[작업 10] handle_new_user trigger 검증
SQL Editor에서 새 가입자 발생 시 profiles 자동 생성되는지 테스트:
  Supabase Auth UI로 가입 → profiles 테이블 확인 → role='user' 기본값

[테스트]
- 미인증 사용자 / 접속 → /login 리디렉션 ✓
- /admin 접속 시 user 권한 → /dashboard 리디렉션 ✓
- admin 권한 → /admin 정상 접속 ✓
- 로그아웃 후 cookie 삭제 ✓

[Plan 단계 필수]
1. 와이어프레임 ASCII로 그려서 OK 받기 (사이드바, 헤더, 메인 영역)
2. 권한별 메뉴 가시성 표 보여주기
3. 디자인 토큰 (다크 테마 색상 코드) 확정
```

---

## Prompt 14 — Web App: 조회 페이지 (Dashboard, Watchlist, Reports)

```
모든 사용자가 접근 가능한 조회 페이지 4개. SKILL.md 12-2번 디자인 따름.

[페이지 1] /dashboard

Server Component로 데이터 페치 (병렬):
  - ai_scores 오늘 날짜, top 5 by final_score
  - global_market 오늘, ['^IXIC', '^GSPC', '^SOX', '^VIX']
  - 섹터별 신호 분포 (sectors GROUP BY signal)

UI:
  - 헤더: "오늘의 한국장 프리뷰 - 2026-05-06"
  - 글로벌 온도 카드 4개 (Nasdaq/S&P/SOX/VIX) — 등락률 + 색상
  - 섹터 온도 그리드 (5개 섹터 칩)
  - 상위 5종목 카드 — 클릭 시 /reports/today/[ticker] 이동
  - 모바일: 카드 단 1열, 데스크탑: 4열

[페이지 2] /watchlist

권한별 분기:
  - admin: stocks where is_watchlist=true (50종목 마스터)
  - beta·user: user_watchlists join stocks (자기 것)

UI:
  - 테이블: 종목명, 티커, 섹터, 오늘 신호, 점수, 전일 등락률, 액션
  - 정렬: 신호 → 점수 desc 기본
  - 검색바 + 섹터 필터
  - 우상단 [+ 종목 추가] (모든 권한, 단 limits 적용)
    - admin: 무제한
    - beta: 30종목 한도
    - user: 10종목 한도
  - 종목 추가 Modal: 종목 검색 (debounced) + 자동완성

[페이지 3] /reports

URL: /reports → 최근 30일 목록
     /reports/[date] → 특정일 프리뷰 (대시보드와 비슷)
     /reports/[date]/[ticker] → 종목 상세

/reports 목록:
  - 캘린더 뷰 + 리스트 뷰 토글
  - 각 일자: 글로벌 온도 요약 + 상위 3종목 미리보기
  - 클릭 → /reports/[date]

/reports/[date]/[ticker]:
  - 종목 상세 카드 (텔레그램 메시지와 동일 정보 + 더 풍부)
  - 7요소 sub_score 막대 차트 (Recharts)
  - 관련 RAG 청크 3개 (Accordion)
  - 관련 뉴스 3개 (외부 링크)
  - 과거 30일 점수 추이 (LineChart)
  - 백테스트 적중 여부 (있으면)

[페이지 4] /settings

SKILL.md 12-2번 텔레그램 연동 UI 그대로:
- 현재 연동 상태 표시
- /link 코드 발급 버튼 → API 호출
  POST /api/settings/link-code → profiles.telegram_link_code 업데이트
  → 6자리 코드 + 5분 카운트다운
- 알림 설정 토글 3개 → profiles 업데이트

[데이터 페치 패턴]
Server Component 우선, 인터랙션 필요 시만 Client Component + TanStack Query.

components/charts/ 디렉토리에 Recharts 래퍼:
  - SubscoreBarChart
  - ScoreTrendLineChart  
  - SectorHeatmap

[테스트]
- /dashboard 데이터 로딩 < 2초
- /watchlist 권한별 데이터 정확히 분기
- /reports/[date] URL로 직접 진입 시 정상 렌더
- 모바일에서 사이드바 햄버거 → Sheet 컴포넌트 동작

[Plan 단계 필수]
디자인 시안을 와이어프레임 또는 Figma 링크로 검토 받고 진행.
```

---

## Prompt 15 — Web App: 편집 페이지 (Mapping, Knowledge, Weights)

```
admin 전용 편집 페이지 3개. 알파의 핵심.

[페이지 1] /mapping (US-KR 매핑 매트릭스)

데이터: us_kr_mapping 테이블 전체 (현재 20~50개 행)

UI (SKILL.md 12-2번 매핑 페이지):
  - 테이블 (TanStack Table 권장):
    * 컬럼: US Symbol, KR Ticker, KR Name, Relation Type, Impact, Updated, Actions
    * 정렬, 필터 가능
  - 인라인 편집:
    * Impact 셀 클릭 → Slider (0~1, step 0.01) + 숫자 입력
    * Relation Type 클릭 → Select (supply_chain, competitor, sector_proxy, ...)
    * Debounce 1s 후 자동 저장 (Toast 알림)
  - [+ 새 매핑] 버튼 → Modal 폼:
    * US Symbol 자유 입력 + 자동완성
    * KR Ticker 자유 입력 + 자동완성  
    * Relation Type select
    * Impact slider
    * Rationale textarea
  - 삭제: 행 우클릭 또는 Action 컬럼 → 확인 Dialog

서버 액션:
  app/(admin)/mapping/actions.ts:
    'use server'
    export async function updateMapping(id, patch) {
      const supabase = await createClient()
      // 1. service_role로 업데이트 (Server Action에서 가능)
      // 2. audit_logs INSERT (changes: {before, after})
      // 3. revalidatePath('/mapping')
    }

[페이지 2] /knowledge (RAG 청크 관리)

목록 페이지 /knowledge:
  - 카드 그리드 (3열 데스크탑 / 1열 모바일)
  - 각 카드: topic, sectors 태그(Badge), related_tickers, 마지막 수정일
  - 필터: 섹터 multi-select, 검색바 (topic + body fuzzy)
  - [+ 새 청크] 버튼 → /knowledge/new
  - 카드 클릭 → /knowledge/[id]

편집 페이지 /knowledge/[id]:
  레이아웃: 좌(40%) 메타데이터 + 우(60%) 마크다운 에디터
  
  좌측 폼 (react-hook-form + zod):
    - topic (required, max 200)
    - markets multi-select [US, KR, ...]
    - sectors multi-select [반도체, 2차전지, ...]
    - related_tickers tag input
    - trigger_conditions array (반복 가능 row)
    - positive_signal select
    - risk_warning textarea
  
  우측 에디터:
    - body 마크다운 (react-md-editor 또는 textarea + preview tab)
    - 우상단 [임베딩 재생성] 버튼:
      → POST /api/knowledge/[id]/regenerate-embedding
      → 진행 표시 → 완료 토스트
  
  하단 액션: [저장] [임시저장] [삭제] [취소]
  
  자동 저장: 30초마다 또는 blur 시
  audit_logs 기록

새 청크 페이지 /knowledge/new:
  - 동일 폼, id 생성 후 저장 → /knowledge/[new_id]로 redirect
  - 저장 시 임베딩 자동 생성

[페이지 3] /weights (가중치 + 임계값)

현재 활성 weight_configs 조회 → 폼 초기값.

UI:
  - 7요소 슬라이더 (각 0.0~1.0, step 0.05)
    - 변경 시 실시간 합계 표시 (필수: 1.00)
    - 합계 != 1.00이면 저장 버튼 비활성화 + 빨간 경고
  - 임계값 5단계 입력 (강한 관심 ≥ 0.80, 관심 ≥ 0.65, ...)
    - 단조 감소 검증 (강한 관심 > 관심 > 관망 > ...)
  - 변경 사유 textarea (필수, 최소 10자)
  - 액션:
    [백테스트 미리보기] → 새 가중치로 최근 30일 시뮬레이션 (GitHub workflow_dispatch로 enqueue)
    [버전으로 저장] → weight_configs INSERT (is_active=false)
    [활성화] → 새 버전 활성화 + 기존 비활성화 (트랜잭션)
  - 우측 패널: 버전 히스토리
    * 각 버전: version, created_by, created_at, notes, [활성화] [복사]
    * diff 보기 (이전 버전 vs 선택 버전)

서버 액션:
  activate(version_id):
    UPDATE weight_configs SET is_active=false WHERE is_active=true;
    UPDATE weight_configs SET is_active=true WHERE id=version_id;
    audit_logs INSERT (action='weights.activate')
    revalidatePath('/weights')

[공통 — 모든 admin 페이지]
- 페이지 진입 시 audit_logs INSERT (action='*.view')는 하지 않음 (잡음)
- CREATE/UPDATE/DELETE 시만 audit_logs 기록
- 변경 후 토스트 (Sonner) "저장됨"

[테스트]
- /mapping 슬라이더 변경 → 1초 후 DB 업데이트 확인
- /knowledge body 수정 + [임베딩 재생성] → rag_chunks.embedding 업데이트 확인
- /weights 합계가 1.0 아니면 저장 불가 확인
- audit_logs에 행위 기록 확인
- 비-admin 접속 시 403 또는 redirect

[Plan 단계 필수]
- 매핑 인라인 편집의 UX 확정 (즉시 저장 vs 일괄 저장)
- 임베딩 재생성 비용 시뮬레이션 (1청크 = $0.0001 정도)
- weights 백테스트 미리보기 시간 (5분 예상) 사용자에게 표시
```

---

## Prompt 16 — Web App: 백테스트 + Admin 대시보드

```
admin 전용 페이지 4개 + 백테스트 비동기 워크플로우.

[페이지 1] /backtest

상단 폼:
  - 기간 (DatePicker × 2)
  - 가중치 버전 select (weight_configs)
  - 전략 라디오: score ≥ 0.65, 강한 관심만, 커스텀
  - 익절/손절 (NumberInput)
  - [실행] 버튼

실행 흐름 (비동기):
  1. POST /api/backtest/start → Redis queue enqueue → job_id 반환
  2. 페이지 하단에 [실행 중...] 카드 표시 + 진행률 폴링
     useQuery(['backtest', job_id], fetchStatus, { refetchInterval: 2000 })
  3. 완료 시 결과 페이지로 자동 navigate

결과 페이지:
  - 요약 카드 4개: 누적 수익률, Sharpe, MDD, 코스피 대비
  - LineChart: 일별 누적 수익률 (전략 vs KOSPI)
  - ScatterChart: Calibration plot (예측 확률 vs 실제 적중)
  - BarChart: 신호별 승률
  - BarChart: 섹터별 성과
  - DataTable: 일별 거래 내역 (가상 매매 가정)
  - [PDF 다운로드]: Storage signed URL → backtest-reports 버킷
  - [공유]: 운영자 텔레그램으로 결과 요약 발송

과거 백테스트 목록:
  - 우측 패널 또는 하단: backtest_results 그룹 by strategy_id
  - 각 과거 결과 클릭 → 결과 페이지 재표시

[페이지 2] /admin/users

테이블:
  컬럼: email, role (Badge), telegram (🟢/⚪), last_login, created_at, Actions
  Action 버튼:
    - [역할 변경] Dialog (admin/beta/user select)
    - [텔레그램 강제 해제] (telegram_chat_id NULL)
    - [비활성화] (Supabase Auth user disable)
    - [삭제] (cascade) — 확인 2번

상단:
  - [+ 베타 초대] Modal:
    이메일 입력 → invite_codes INSERT (expires=7d) → 이메일 발송
    (Supabase Auth send invitation 또는 Resend API)
  - 통계: 총 사용자 수, role별 분포, 최근 7일 가입자

[페이지 3] /admin/data-quality

지난 14일 카드 그리드:
  날짜별 카드:
    - 수집 성공률 (예: 49/50 = 98%)
    - 정제 폐기율 (예: 14.2% — 색상으로 정상/경고)
    - LLM 호출 + 비용 ($1.23)
    - 알림 발송 (📧 5/5)
    - 전체 평가: 🟢/🟡/🔴

차트 (Recharts):
  - 14일 캐시 적중률 LineChart
  - 출처별 신뢰도 점수 BarChart (KRX/Finnhub/News)
  - 일별 LLM 비용 trend LineChart

최근 에러 로그:
  - audit_logs + system_errors 테이블 (없으면 새로 추가)
  - 최근 50건, 색상 코딩

[페이지 4] /admin/notifications

발송 이력 테이블:
  - 컬럼: 날짜, 채널, 수신자, 상태, 에러, 시간
  - 필터: 채널, 상태(success/failed), 날짜 범위
  - 상태가 failed인 행 클릭 → 에러 상세 + [재발송] 버튼

DRY_RUN 미리보기:
  - 우측 패널: "오늘 발송될 메시지" 미리보기
  - GET /api/notifications/preview-today
  - 채팅 풍선 형태로 표시 (Telegram 시뮬레이션)
  - [지금 수동 발송] 버튼 (확인 Dialog 필수)

[apps/api 보강]

apps/api/routes/backtest.py (SKILL.md 11-3 패턴):
  POST /api/backtest/start
    1. backtest_jobs 테이블에 'queued' INSERT (job_id 발급)
    2. GitHub workflow_dispatch API 호출 (backtest.yml 트리거)
    3. job_id 반환 (웹은 폴링 또는 Realtime으로 추적)
  GET /api/backtest/{job_id}/status → backtest_jobs 테이블 조회
  GET /api/backtest/{job_id}/result → Storage signed URL

apps/api/routes/notifications.py:
  GET /api/notifications/preview-today
  POST /api/notifications/send-now (admin 검증)

apps/api/routes/users.py:
  POST /api/users/invite (admin only) — invite_codes 발급 + 이메일 발송
  PATCH /api/users/{id}/role (admin only, audit log)

[GitHub Actions 백테스트 워크플로우 보강]

.github/workflows/backtest.yml (이미 Prompt 01에서 생성됨, SKILL.md 11-3 참조):
  workflow_dispatch 입력: job_id, start_date, end_date, strategy, weight_config_id

signal/backtest_status.py (helper):
  argparse로 호출:
    --job-id, --status (queued|running|completed|failed)
    --run-url (GitHub Actions 실행 URL, 사용자가 로그 직접 확인 가능)
  backtest_jobs 테이블 UPDATE.

signal/backtest.py:
  - argparse: --job-id --start --end --strategy --weight-config-id
  - 실행:
    1. backtest_jobs에서 params 조회 (또는 argparse로 직접)
    2. 50종목 walk-forward 시뮬레이션
    3. 진행률 주기적 업데이트 (backtest_jobs.progress 0~100)
    4. 결과 PNG/HTML 생성 → Supabase Storage backtest-reports/ 업로드
    5. backtest_results 테이블 INSERT
    6. backtest_jobs.status='completed', result_url 채워서 UPDATE

[테스트]
- 백테스트 1회 실행 → Storage 결과물 + DB 행 모두 확인
- /admin/users 베타 초대 → 이메일 수신 → 가입 → role='beta' 확인
- /admin/data-quality 14일치 데이터 정상 표시
- DRY_RUN 미리보기 정확성

[Plan 단계 필수]
백테스트 비동기 워크플로우 시퀀스 다이어그램 그려서 검토 받기.
```

---

## Prompt 17 — Telegram ↔ Web App 연동 (link 코드)

```
SKILL.md 12-5번 흐름 그대로 구현.

[Part A] 웹앱 측 (apps/web)

/settings 페이지에서:
  
  [코드 발급] 버튼 클릭 → Server Action:
    'use server'
    export async function generateLinkCode() {
      const supabase = await createClient()
      const user = (await supabase.auth.getUser()).data.user
      const code = String(Math.floor(100000 + Math.random() * 900000))  // 6자리
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000)  // 5분
      
      await supabase.from('profiles')
        .update({ 
          telegram_link_code: code, 
          link_code_expires_at: expiresAt.toISOString() 
        })
        .eq('id', user.id)
      
      revalidatePath('/settings')
      return { code, expiresAt }
    }
  
  화면에 코드 표시 + 카운트다운 (5분):
    "텔레그램에서 다음 명령을 입력하세요: /link 837456"
    "남은 시간: 4:32" (자동 갱신)

[Part B] 텔레그램 측 (apps/api/routes/telegram_webhook.py)

핸들러 추가:

async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /link 837456
    사용자가 입력한 코드로 텔레그램 chat_id를 profiles에 연결.
    """
    args = context.args
    if not args or len(args[0]) != 6 or not args[0].isdigit():
        await update.message.reply_text(
            "형식: /link 123456 (웹앱 /settings에서 발급한 6자리 코드)"
        )
        return
    
    code = args[0]
    chat_id = str(update.effective_chat.id)
    
    # Supabase RPC 호출 (SKILL.md 12-5번 link_telegram 함수)
    sb = get_admin_client()
    result = sb.rpc("link_telegram", {
        "p_link_code": code,
        "p_chat_id": chat_id,
    }).execute()
    
    if result.data and result.data.get("success"):
        email = result.data.get("email", "")
        await update.message.reply_text(
            f"✅ 연동 완료!\n\n"
            f"계정: {email}\n"
            f"이제 매일 06:30 KST에 프리뷰가 발송됩니다.\n\n"
            f"명령어: /today /stock /sector /top /risk /help"
        )
    else:
        await update.message.reply_text(
            "❌ 코드가 유효하지 않거나 만료되었습니다.\n"
            "웹앱에서 새 코드를 발급받으세요."
        )

[Part C] Supabase RPC 함수

supabase/migrations/00000000000009_link_telegram_rpc.sql:

CREATE OR REPLACE FUNCTION link_telegram(
    p_link_code VARCHAR,
    p_chat_id VARCHAR
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER  -- service_role 권한으로 실행
AS $$
DECLARE
    v_profile RECORD;
BEGIN
    SELECT id, email INTO v_profile
    FROM profiles
    WHERE telegram_link_code = p_link_code
      AND link_code_expires_at > NOW()
    LIMIT 1;
    
    IF v_profile IS NULL THEN
        RETURN jsonb_build_object('success', false);
    END IF;
    
    -- 이미 다른 사용자가 같은 chat_id를 쓰고 있으면 해제
    UPDATE profiles
    SET telegram_chat_id = NULL
    WHERE telegram_chat_id = p_chat_id
      AND id != v_profile.id;
    
    -- 연동
    UPDATE profiles
    SET telegram_chat_id = p_chat_id,
        telegram_link_code = NULL,
        link_code_expires_at = NULL
    WHERE id = v_profile.id;
    
    RETURN jsonb_build_object(
        'success', true,
        'email', v_profile.email,
        'user_id', v_profile.id
    );
END;
$$;

[Part D] 일일 발송 대상 변경

orchestrator/pipeline.py 발송 단계에서:

# 변경 전: TELEGRAM_CHAT_IDS 환경변수
# chat_ids = os.getenv("TELEGRAM_CHAT_IDS").split(",")

# 변경 후: profiles에서 동적 조회
chat_ids = sb.table("profiles") \
    .select("telegram_chat_id") \
    .not_.is_("telegram_chat_id", "null") \
    .eq("notification_enabled", True) \
    .execute()

for row in chat_ids.data:
    await telegram.send_preview(row["telegram_chat_id"], reports)

[Part E] /feedback 명령어 (텔레그램에서 피드백 수집)

async def cmd_feedback(update, context):
    """
    /feedback → 인터랙티브 폼 시작
    1단계: 정확도 (1~5 InlineKeyboard)
    2단계: 유용성 (1~5 InlineKeyboard)
    3단계: 코멘트 (텍스트 입력 또는 skip)
    """
    # ConversationHandler 사용 (python-telegram-bot)
    # 결과는 user_feedback 테이블에 INSERT (source='telegram')

[테스트]
- 웹에서 코드 발급 → 텔레그램 /link → profiles.telegram_chat_id 채워짐 ✓
- 만료된 코드 → 에러 메시지 ✓
- 다른 사용자가 같은 chat_id 시도 → 기존 해제 + 새로 연결 ✓
- 일일 파이프라인 → profiles 기반 발송 ✓
- /feedback 명령 → user_feedback 행 생성 ✓

[Plan 단계 필수]
- 코드 길이 6자리 vs 8자리 결정 (보안 vs UX)
- 만료 시간 5분 vs 10분
- /feedback 흐름이 너무 길면 단축 검토
```

---

## 실행 순서 요약

```
Week 1
├─ Day 1-2: 사전 준비 A~F (Supabase + Telegram + GitHub + Vercel + GitHub PAT 가입·연결)
├─ Day 3:   Prompt 01 (Bootstrap — 폴더 + 마이그레이션 + 배포 설정 + 웹앱 스캐폴드 자리)
└─ Day 4-5: Prompt 02 (Collectors)

Week 2
├─ Day 1-2: Prompt 03 (Refinery)
└─ Day 3-5: Prompt 04, 05 (Cognition + RAG)

Week 3
├─ Day 1-3: Prompt 06 (Scorer + GBM)
└─ Day 4-5: Prompt 07 (Report)

Week 4
├─ Day 1-2: Prompt 08 (Notifier — Telegram polling + webhook)
├─ Day 3:   Prompt 09 (Executor)
└─ Day 4-5: Prompt 10 (Orchestrator + Backtest 백엔드)

Week 5
├─ Day 1-2: Prompt 11 (Deploy — GitHub Actions 워커 + Vercel 웹/API 배포)
├─ Day 3:   Telegram Webhook 등록 + 첫 파이프라인 실 데이터 검증
└─ Day 4-5: Prompt 13 (Web App Bootstrap — Next.js + Auth + Middleware)

Week 6
├─ Day 1-2: Prompt 14 (Dashboard, Watchlist, Reports, Settings 조회 페이지)
└─ Day 3-5: Prompt 15 (Mapping, Knowledge, Weights 편집 페이지)

Week 7
├─ Day 1-3: Prompt 16 (Backtest + Admin 대시보드 4개)
└─ Day 4-5: Prompt 17 (Telegram ↔ Web 연동 + /feedback)

Week 8
├─ Day 1-2: 통합 QA + 베타 테스터 1~2명 합류
├─ Day 3-4: Prompt 12 (모니터링 + 가중치 첫 튜닝)
└─ Day 5:   v0.1.0 정식 릴리즈

Week 9+
├─ 운영 모니터링, 사용자 피드백 수집
├─ Phase 2 검토:
│   - 일반 사용자 셀프 가입 활성화
│   - 카카오 알림톡 추가
│   - Paper Trading 활성화
│   - 가중치 튜닝 자동화
│   - **Alpha Vantage MCP 통합 페이지** (admin ad-hoc 분석)
│     * /admin/analyze 신설 — 자연어 질문 입력
│     * Claude API + Alpha Vantage 공식 MCP (mcp.alphavantage.co)
│     * 예: "지난 30일 SK하이닉스와 NVDA 상관관계", "삼성전자 RSI/MACD"
│     * 결과를 차트 + 텍스트로 admin에게 표시
└─ Phase 3 검토 (장기): 증권사 API 연동
```

---

## Prompt 사용 시 주의사항

1. **각 Prompt 시작 시** Claude Code에게 다음을 명시:
   - "CLAUDE.md와 SKILL.md를 먼저 읽어줘"
   - "6단계 프로토콜 지킬 것"

2. **Plan 단계 출력**을 받은 후 반드시 검토:
   - 클래스/함수 시그니처가 SKILL.md와 일치하는가
   - Pydantic 모델 필드가 빠짐없이 있는가
   - 테스트 케이스가 충분한가

3. **각 Prompt 완료 시** git commit:
   ```
   git commit -m "feat(<module>): implement <prompt-N> [<scope>]"
   ```

4. **막히면** Claude Code에게:
   - "PROMPTS.md의 Prompt N 다시 읽고 진행"
   - "CLAUDE.md ABSOLUTE RULES 위반 여부 점검"

---

*Last updated: 2026-05-05*
