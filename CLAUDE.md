# QuantSignal — Project Constitution

> 이 파일은 모든 Claude Code 세션 시작 시 자동 로드된다.
> 여기 적힌 ABSOLUTE RULES는 사용자가 명시적으로 수정 요청하기 전까지 절대 변경되지 않는다.

---

## 1. Mission

미국장 마감 후 ~ 한국장 시작 전 90분 동안, 글로벌 선행 신호를 한국 관심종목 단위로 번역하여
**[강한 관심 / 관심 / 관망 / 주의 / 위험]** 5등급 신호를 Telegram(Beta) 또는 카카오톡(정식)으로 발송한다.

본 서비스는 자동매매 봇이 아니라 **AI 투자 판단 보조 시스템**이다.

---

## 2. Scope (반드시 지킬 범위)

### 2-1. 초기 대상 종목 (5섹터 × 10종목 = 50종목)

| 섹터 | 종목 (티커) |
|---|---|
| 반도체 | 삼성전자(005930), SK하이닉스(000660), 한미반도체(042700), 리노공업(058470), 동진쎄미켐(005290), 원익IPS(240810), 이오테크닉스(039030), 솔브레인(357780), 하나마이크론(067310), DB하이텍(000990) |
| 2차전지 | LG에너지솔루션(373220), 삼성SDI(006400), 포스코퓨처엠(003670), 에코프로비엠(247540), 에코프로(086520), 엘앤에프(066970), SK이노베이션(096770), 코스모신소재(005070), 천보(278280), 더블유씨피(393890) |
| 자동차 | 현대차(005380), 기아(000270), 현대모비스(012330), HL만도(204320), 한온시스템(018880), 현대위아(011210), 에스엘(005850), 화신(010690), 성우하이텍(015750), 평화정공(043370) |
| 바이오/헬스 | 삼성바이오로직스(207940), 셀트리온(068270), 유한양행(000100), SK바이오팜(326030), HLB(028300), 알테오젠(196170), 리가켐바이오(141080), 한미약품(128940), 녹십자(006280), 종근당(185750) |
| 인터넷/AI | NAVER(035420), 카카오(035720), 크래프톤(259960), 엔씨소프트(036570), 펄어비스(263750), 더존비즈온(012510), 카페24(042000), 안랩(053800), 이수페타시스(007660), 케이아이엔엑스(093320) |

### 2-2. 사용자 인터페이스 (이중 채널 구조)

본 서비스는 **편집·관리는 웹앱, 결과 소비는 텔레그램**으로 명확히 분리한다.

**Phase 1 (Beta) — Web App + Telegram Bot 동시 운영**

#### A. Web App (Next.js, 데스크탑/모바일 반응형)
- 도메인: Vercel 자동 도메인 또는 사용자 도메인
- 모든 편집·관리 작업 수행
- 데스크탑 우선 설계, 모바일 반응형 지원 (편집 폼은 데스크탑 권장)
- 페이지 구조:
  - `/` — 로그인 (인증되지 않으면) 또는 `/dashboard` 리디렉션
  - `/dashboard` — 오늘의 시장 온도 + 상위 종목
  - `/watchlist` — 관심 50종목 관리
  - `/mapping` — US-KR 매핑 매트릭스 편집 (admin only)
  - `/knowledge` — RAG 청크 관리 (admin only)
  - `/weights` — 7요소 가중치 + 신호 임계값 (admin only)
  - `/backtest` — 백테스트 실행·결과 시각화 (admin only)
  - `/reports/[date]` — 일일 리포트 히스토리
  - `/reports/[date]/[ticker]` — 종목별 상세
  - `/admin/users` — 사용자 관리 (admin only)
  - `/admin/data-quality` — 데이터 품질·비용 대시보드 (admin only)
  - `/admin/notifications` — 알림 로그·DRY_RUN 미리보기 (admin only)
  - `/settings` — 텔레그램 연동·알림 설정

#### B. Telegram Bot (모바일 우선, 읽기 + 가벼운 명령)
- BotFather 봇, Webhook 방식 (Vercel `apps/api/`에서 처리)
- **편집 기능 없음** — 모든 편집은 웹앱으로 유도 (`이 작업은 웹앱에서: <link>`)
- 일일 자동 발송:
  - 06:30 KST 프리뷰 (등록된 chat_id 전체)
  - 07:30 KST 운영자 전용 헬스체크 (admin 전용)
- 명령어:
  - `/start` — 환영 + 웹앱 가입 링크
  - `/link <code>` — 웹앱 계정과 텔레그램 chat_id 연동 (웹앱에서 발급한 일회용 코드)
  - `/today` — 오늘 프리뷰 다시 보기
  - `/stock 005930` — 특정 종목 상세
  - `/sector 반도체` — 섹터 요약
  - `/top` / `/risk` — 상위/위험 종목
  - `/feedback` — 피드백 입력 (정확도·유용성 1~5점)
  - `/help` — 명령어 안내

**Phase 2 (정식) — 추가**
- 일반 사용자 셀프 가입 활성화
- Kakao Biz Message 추가 (텔레그램 외 채널)
- 결제·구독 (선택)

### 2-3. 권한 설계 (3단계)

| 역할 | 가입 경로 | 권한 범위 |
|---|---|---|
| `admin` | Supabase Dashboard에서 수동 승격 | 모든 편집·관리 + 베타 초대 |
| `beta` | admin이 이메일 초대 | 자기 watchlist, 리포트 열람, 피드백, 텔레그램 연동 |
| `user` | Phase 2부터 셀프 가입 | 리포트 열람, 제한된 watchlist (10종목), 텔레그램 연동 |

권한은 `auth.users.user_metadata.role`에 저장. `profiles` 테이블에 동기화. 모든 사용자 데이터 테이블에 RLS 정책 필수.

### 2-3. Execution 정책
- **MVP 단계**: 리포트 + 알림 발송만
- **Phase 2**: Paper Trading (가상매매 시뮬레이션)
- **Phase 3 (옵션)**: 증권사 API 연동 — 단, `executor/` 폴더 인터페이스만 미리 정의하고 실제 연동 코드는 사용자 명시적 승인 후에만 작성
- `executor/broker_interface.py` 추상 클래스 → `PaperBroker` (즉시 구현) / `KISBroker`, `KiwoomBroker` (인터페이스만)

---

## 3. ABSOLUTE RULES (절대 어기지 말 것)

### A. 표현 규칙 (보고서·알림에 적용)
- **금지어**: "매수", "매도", "강력 추천", "오늘 오른다", "확정", "보장", "100%"
- **허용어**: "관심 신호", "긍정 요인 우세", "리스크 확인 필요", "관망 권장", "변동성 주의"
- 모든 신호에는 반드시 **(1) 근거 3개 + (2) 리스크 2개**를 함께 표시
- 리포트 하단에 고정 면책 문구: *"본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다."*
- 금지어 자동 검증 hook을 `signals/report.py`에 포함 — 금지어 발견 시 ValueError raise

### B. 데이터 규칙
- Raw API 응답을 절대 직접 사용하지 않는다. 반드시 `refinery/` 통과
- Pydantic v2 스키마 검증 실패 데이터는 **폐기 + 로그**, 절대 보정하지 않는다
- 14.45% 오류율을 가정하고 항상 결측/이상치 처리 코드를 함께 작성
- 날짜는 `YYYY-MM-DD` (KST), 티커는 6자리 문자열, 통화는 KRW 단일

### C. AI 호출 규칙
- 동일 (종목, 일자) 점수는 캐시 — 재호출 금지 (Redis or DB cache)
- 감성 점수는 `0.0 ~ 1.0` float, label은 `{very_negative, negative, neutral, positive, very_positive}` 5단계 enum
- 모든 LLM 호출에 다음 3개 강제: ① system prompt ② few-shot 3개 이상 ③ structured output (Pydantic)
- LLM 응답 파싱 실패 시 retry 2회, 그래도 실패하면 해당 종목 점수 산출 skip + 로그

### D. 자동매매 안전장치
- `executor/` 폴더 외에서는 어떤 거래 API도 호출하지 않는다
- `KISBroker`, `KiwoomBroker` 클래스는 `NotImplementedError`만 raise하는 stub으로 시작
- 실거래 API 키는 `.env`에 두지 않고 별도 `secrets.kr.local` (gitignored)
- 환경변수 `EXECUTION_MODE`가 `paper` 또는 `report_only`가 아니면 파이프라인 시작 거부

### E. Supabase 사용 규칙
- **Service Role Key는 Python 백엔드에서만 사용** — 절대 클라이언트(텔레그램 봇 응답 메시지 등)에 노출 금지
- 백엔드(파이프라인 워커, FastAPI)는 Service Role Key로 RLS 우회
- 사용자 노출 가능성이 있는 컨텍스트(미래 웹 인터페이스)는 Anon Key + JWT만 사용
- 모든 사용자 데이터 테이블(`watchlists`, `notifications` 등)에는 RLS 정책 필수
- 마이그레이션은 `supabase/migrations/` 디렉토리에 SQL 파일로 관리, 직접 SQL Editor에서 수정 금지
- pgvector 확장은 Supabase Dashboard → Database → Extensions에서 활성화 후 마이그레이션 작성
- Storage 버킷은 모두 private (public 버킷 금지) — 필요 시 signed URL 발급

### F. 배포 분리 규칙 (Vercel + GitHub Actions)
- **단일 monorepo, 분리 실행** — 같은 GitHub 저장소에서 Vercel은 웹, GitHub Actions는 워커 작업 수행
- **Vercel 배포 대상**: `apps/web/` (Next.js, 메인) + `apps/api/` (FastAPI Functions)
  - `vercel.json`이 두 앱을 함께 빌드, Next.js가 root, FastAPI는 `/api/*` 경로
  - FastAPI 함수 실행 시간 < 60초 보장 — 무거운 작업은 GitHub Actions에 위임
- **GitHub Actions 실행 대상**: 저장소 루트 (collectors, refinery, cognition, signal, orchestrator)
  - `.github/workflows/daily-pipeline.yml`: 매일 06:00 KST cron + 수동 트리거
  - `.github/workflows/backtest.yml`: 사용자가 웹에서 트리거 시 `workflow_dispatch`로 실행
  - `.github/workflows/ci.yml`: PR/push 시 lint + test
  - `.github/workflows/migrate.yml`: main + supabase/migrations/** 변경 시 마이그레이션
- **Telegram Bot 방식**: Vercel은 **webhook 전용**, polling 금지
  - `notifier/bot_runner.py`(polling)는 로컬 개발용으로만 유지
  - 운영용은 `apps/api/routes/telegram_webhook.py`로 처리
- **GitHub Actions 비용**: Public repo 무제한 / Private repo 월 2,000분 무료 (Pro $4/월이면 3,000분)
  - 일일 파이프라인 30분 × 22영업일 = 660분/월 → 무료 한도 내 충분
- **수동 트리거**: Actions UI의 "Run workflow" 버튼 또는 `apps/api`에서 GitHub API 호출
- **DB 마이그레이션**: GitHub Actions에서 `supabase db push`

### F-2. Railway 미사용 결정 (참고)
- Railway는 본 프로젝트에서 사용하지 않는다
- 다음 시나리오 도래 시에만 도입 검토:
  1. 사용자 인터랙션 백테스트의 시작 지연(~30초)이 UX에 치명적일 때
  2. Phase 3 증권사 API 연동으로 24시간 long-running 워커 필요할 때
  3. 실시간 큐 처리량이 GitHub Actions의 동시 실행 한도를 넘을 때
- 위 시나리오 발생 시 별도 세션에서 `Dockerfile.worker` + `railway.toml` 추가

### G. 웹앱 보안 + UX 규칙
- **권한 라우팅은 Next.js middleware에서 검증**: `/admin/*` 경로는 `role === 'admin'`인 사용자만, RLS만 믿지 않는다
- **데이터 가져오기 우선순위**:
  1. Server Component에서 Supabase Server Client 직접 조회 (가장 빠름)
  2. 클라이언트 인터랙션이 필요하면 TanStack Query + Supabase Browser Client
  3. 무거운 작업(백테스트 실행, LLM 호출 트리거)은 FastAPI(`apps/api`) 호출
- **Service Role Key는 절대 Next.js 클라이언트 코드에 노출 금지** — Anon Key + RLS만 사용
- **Next.js Server Component / Route Handler에서 Service Role Key 사용 가능** (서버 환경)
- **모든 사용자 입력 폼**: zod 스키마 검증 → react-hook-form → Supabase upsert
- **반응형 우선순위**:
  - 데스크탑(≥1024px): 전체 기능 노출, 사이드바 + 메인 영역
  - 태블릿(768~1023px): 사이드바 토글, 매핑·RAG 편집 가능
  - 모바일(<768px): 조회 + 간단 편집만 (가중치 슬라이더, 종목 추가/삭제), 매핑 매트릭스·RAG 편집은 데스크탑 권장 안내
- **다크 테마 기본** (베이영 님 KinderBoard·MeetFlow 패턴), 라이트 모드 토글 옵션
- **금지어 검증은 서버에서도 수행**: 클라이언트에서 통과해도 FastAPI가 다시 검증
- **편집 작업은 audit log 기록**: `audit_logs` 테이블에 누가·언제·무엇을 변경했는지

### H. 텔레그램과 웹앱의 책임 분리
- **텔레그램에서 절대 하지 않을 것**:
  - 종목 추가/삭제, 매핑 편집, RAG 편집, 가중치 변경
  - 백테스트 실행
  - 사용자 관리
- **텔레그램이 하는 것**:
  - 일일 자동 프리뷰 수신 (06:30 KST)
  - 조회 명령어 (`/today`, `/stock`, `/sector`, `/top`, `/risk`)
  - 인라인 키보드 탐색
  - 피드백 응답 (`/feedback`)
  - 운영자 헬스체크 알림
- **편집이 필요한 명령어 응답 시 웹앱 링크로 유도**:
  - 사용자가 `/edit_watchlist` 같은 명령 시도 → "이 작업은 웹앱에서: https://...vercel.app/watchlist"
- **텔레그램 ↔ 웹앱 계정 연동**:
  - 웹앱 `/settings`에서 일회용 6자리 코드 발급 (5분 유효)
  - 텔레그램에서 `/link 123456` → DB의 `profiles.telegram_chat_id` 업데이트
  - 연동된 chat_id만 일일 프리뷰 발송 대상

### I. MCP vs SDK 사용 원칙
- **배치 파이프라인은 SDK만 사용** — 매일 06:00 KST 자동 수집은 결정론적이어야 하므로 LLM 추론 비용을 발생시키는 MCP 부적합
  - `collectors/` 모듈은 모두 Python SDK 직접 호출 (`finnhub-python`, `pykrx`, `edgartools` 등)
  - `cognition/sentiment.py`, `signals/report.py`도 Anthropic SDK 직접 호출
- **MCP는 대화형·ad-hoc 분석에만 사용**:
  - Alpha Vantage 공식 원격 MCP 서버 (`https://mcp.alphavantage.co/`) 활용
  - 용도: admin 웹앱의 ad-hoc 분석 페이지, Claude Code 개발 시 데이터 탐색
  - 위치: `cognition/mcp_clients/` (필요 시)
- **Finnhub은 MCP 사용하지 않음** — 공식 MCP 부재, 자체 호스팅 부담, 배치 용도엔 SDK가 적합
- **MVP에서는 MCP 통합 페이지 만들지 않음** — Phase 2 또는 admin 명시 요청 시 추가
  - 단, 베이영 님이 Claude Code 로컬 환경에서 Alpha Vantage MCP를 자유롭게 활용하는 것은 권장

---

## 4. 6단계 인간 확인 프로토콜

KinderBoard에서 검증된 패턴. 각 단계 사이에 사용자 승인 없이 다음으로 넘어가지 않는다.

```
1. Plan      — 무엇을 만들지 자연어로 설명
2. Confirm   — 사용자 "OK" 후 진행
3. Code      — 실제 구현
4. Test      — pytest 작성 및 실행
5. Review    — diff 보여주기
6. Commit    — git commit (사용자가 메시지 검토 후)
```

---

## 5. Tech Stack

| 영역 | 선택 |
|---|---|
| Backend Language | Python 3.11 |
| Backend API | FastAPI + Pydantic v2 |
| **Frontend** | **Next.js 14 (App Router) + TypeScript** |
| **UI Framework** | **Tailwind CSS + shadcn/ui** |
| **State / Forms** | **TanStack Query + react-hook-form + zod** |
| **Charts** | **Recharts (백테스트 시각화)** |
| **DB / Auth / Storage** | Supabase (PostgreSQL 15 + pgvector + Auth + Storage) |
| DB Client (Python) | `supabase-py` v2 + `psycopg[binary]` |
| DB Client (TS) | `@supabase/supabase-js` v2 + `@supabase/ssr` |
| Cache | Redis 7 (Upstash 권장) |
| AI (Sentiment, Report) | Claude Sonnet 4.7 |
| AI (Embedding) | OpenAI `text-embedding-3-small` |
| AI (Prediction) | scikit-learn GradientBoostingClassifier |
| Schedule | **GitHub Actions Cron** (06:00 KST, 무료) |
| Notification (Beta) | Telegram Bot API (Webhook 방식) |
| Notification (정식) | Kakao Biz Message API (Phase 2) |
| Source Control | GitHub (단일 monorepo) |
| Deployment (Web + API) | **Vercel** — Next.js + FastAPI Functions |
| Deployment (Worker) | **GitHub Actions Runner** — 스케줄·수동 트리거 |
| CI/CD | GitHub Actions (lint, test, migration, pipeline 통합) |

### 배포 분리 (단순화 — 3개 인프라로 통합)

```
GitHub: 코드 + Actions (CI/CD + 일일 파이프라인 Cron)
Vercel: apps/web (Next.js) + apps/api (FastAPI Serverless)
Supabase: DB + Auth + Storage + pgvector
```

- **Vercel**: 사용자 인터랙션, 가벼운 DB 조회, Telegram Webhook (60초 이내)
- **GitHub Actions**: 데이터 수집·정제, LLM 호출, ML 학습, 백테스트 (60분 이내)
- **Supabase**: 모든 데이터의 단일 소스 (single source of truth)

**Railway·VPS는 사용하지 않는다.** 향후 다음 시나리오에서만 도입 검토:
- 사용자 인터랙션 백테스트 응답 시간이 GitHub Actions 시작 지연(~30초)으로 부족할 때
- Phase 3 증권사 API 연동 시 24시간 long-running 워커 필요할 때

이 시나리오 도래 전까지는 GitHub Actions만으로 충분.

**Frontend(Next.js, React)는 `apps/web/` 디렉토리에서만 작성한다.** 다른 디렉토리에 React 컴포넌트 작성 금지.

### Supabase 사용 범위 (중요)

**Supabase로 처리하는 것:**
- PostgreSQL 데이터베이스 (모든 9개 테이블)
- pgvector 확장 (RAG 임베딩, 뉴스 임베딩)
- Storage 버킷:
  - `raw-api-backups/` — 수집 원본 JSON (날짜별 폴더)
  - `backtest-reports/` — 백테스트 결과 PNG·HTML
  - `daily-reports/` — 일일 마크다운 리포트 아카이브
- Auth (Phase 2 사용자 회원제 활성화 시)
- Row Level Security (베타 테스터별 관심종목 격리)

**Supabase로 처리하지 않는 것 (Python 워커 유지):**
- 모든 데이터 수집·정제 (pykrx, finnhub-python, edgartools)
- LLM 호출 (감성 분석, 리포트 생성)
- ML 모델 학습·예측 (scikit-learn)
- 백테스트 (메모리·CPU 집약적)
- Telegram 봇 polling

**이유**: Edge Functions는 Deno/TypeScript 환경이며 1초 실행 제한. Python 생태계 라이브러리 사용 불가. ML 학습 부적합. → Python 워커가 Supabase에 client로 접속하는 구조.

---

## 6. Folder Boundaries

```
collectors/        ─ 외부 API 호출만. 비즈니스 로직 금지         [GitHub Actions]
refinery/          ─ 데이터 검증·정제만. 외부 API 호출 금지       [GitHub Actions]
cognition/         ─ LLM·임베딩·매핑·점수 산출                    [GitHub Actions]
signals/           ─ ML 모델·백테스트·리포트 생성 (※ Python stdlib `signal` 충돌 방지를 위해 복수형) [GitHub Actions]
executor/          ─ 거래 실행 인터페이스 (PaperBroker만)         [GitHub Actions]
orchestrator/      ─ 파이프라인 조립·스케줄링                     [GitHub Actions]
notifier/          ─ Telegram 메시지 포맷터                      [공유]
db/                ─ Supabase client, Storage client            [공유]
apps/api/          ─ FastAPI + Telegram Webhook + Web App API   [Vercel]
apps/web/          ─ Next.js 14 (App Router) — 운영 + 사용자 UI [Vercel]
tests/             ─ pytest, 14.45% 오류 시뮬레이션 필수
supabase/          ─ migrations + seed SQL
.github/workflows/ ─ CI/CD + daily pipeline cron + 백테스트 트리거
vercel.json        ─ Vercel 빌드 설정 (web + api 동시 배포)
```

`[GitHub Actions]` 라벨은 해당 모듈이 GitHub Actions Runner에서 실행됨을 의미.
`[Vercel]` 라벨은 Vercel Serverless에서 실행됨.
`[공유]`는 두 환경 모두에서 import 가능.

### 6-1. apps/web/ 내부 구조

```
apps/web/
├── app/                       # Next.js App Router
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── invite/[token]/page.tsx
│   ├── (app)/                 # 인증된 사용자 (모든 권한)
│   │   ├── layout.tsx
│   │   ├── dashboard/page.tsx
│   │   ├── watchlist/page.tsx
│   │   ├── reports/
│   │   │   ├── page.tsx               # 히스토리 목록
│   │   │   ├── [date]/page.tsx        # 일자별 프리뷰
│   │   │   └── [date]/[ticker]/page.tsx
│   │   └── settings/page.tsx          # Telegram 연동·알림
│   ├── (admin)/               # admin 권한만 (middleware 검증)
│   │   ├── layout.tsx
│   │   ├── mapping/page.tsx
│   │   ├── knowledge/
│   │   │   ├── page.tsx               # 청크 목록
│   │   │   └── [id]/page.tsx          # 청크 편집
│   │   ├── weights/page.tsx
│   │   ├── backtest/page.tsx
│   │   ├── users/page.tsx
│   │   ├── data-quality/page.tsx
│   │   └── notifications/page.tsx
│   ├── api/                   # Next.js Route Handlers (가벼운 작업만)
│   │   └── trpc/[trpc]/route.ts       # 또는 직접 Supabase Server Client
│   └── layout.tsx
├── components/
│   ├── ui/                    # shadcn/ui 컴포넌트
│   ├── charts/                # Recharts 래퍼
│   ├── forms/
│   └── layout/
├── lib/
│   ├── supabase/
│   │   ├── client.ts          # Browser client (Anon Key)
│   │   ├── server.ts          # Server Component client
│   │   └── middleware.ts      # Auth 미들웨어
│   ├── api-client.ts          # FastAPI 호출 (apps/api)
│   └── utils.ts
├── middleware.ts              # 권한 라우팅
├── tailwind.config.ts
├── package.json
└── tsconfig.json
```

각 폴더는 다른 폴더의 내부 구현을 import하지 않는다 — `__init__.py`/`index.ts`에 export된 인터페이스만 사용.

`apps/api/`는 본 저장소의 다른 모듈을 import할 수 있지만, **Vercel 빌드 시간(60초)과 빌드 사이즈(250MB)를 고려해 무거운 라이브러리(scikit-learn, pykrx 등)는 import하지 않는다.** 무거운 작업은 GitHub Actions Runner로 위임 (workflow_dispatch 트리거).

`apps/web/`은 백엔드 Python 코드를 직접 import하지 않는다. Supabase 직접 조회 또는 `apps/api/` HTTP 호출만 사용.

---

## 7. RAG Knowledge Base 청킹 원칙

청킹은 "문단 단위"가 아니라 **투자 판단 단위**.

```yaml
chunk_id: nvda_kr_hbm_001
topic: "Nvidia 상승이 한국 HBM 관련주에 미치는 영향"
markets: [US, KR]
sectors: [semiconductor]
related_tickers: [NVDA, "000660", "042700"]
trigger_conditions:
  - "Nvidia 종가 상승 > 2%"
  - "Philadelphia Semi Index 동반 상승"
  - "HBM 관련 뉴스 감성 > 0.6"
positive_signal: "강한 관심"
risk_warning: "장 초반 갭상승 시 추격매수 위험"
historical_examples: [...]
```

초기 RAG 청크는 5섹터 × 4~6개 = **약 25~30개**로 시작.

---

## 8. Cost Discipline

- LLM 호출 1회당 토큰 예산: input 4k, output 1k
- 일일 LLM 호출 상한: 200건 (50종목 × 4회)
- 초과 시 자동 중단 + 알림
- 캐시 적중률 < 70% 인 날은 운영자에게 경고

---

## 9. Definition of Done (단계별 완료 기준)

| Phase | 완료 기준 |
|---|---|
| Phase 1 (Collectors) | 50종목 × 5영업일 데이터가 cleaned DB에 적재, 누락률 < 1% |
| Phase 2 (Refinery) | 의도적 오류 100건 → 정확히 14~15건 폐기 |
| Phase 3 (Cognition) | 동일 입력 점수 분산 < 0.1 (3회 호출 평균) |
| Phase 4 (Signal) | 6개월 백테스트 승률 > 코스피 단순 보유 + Calibration plot 생성 |
| Phase 5 (Notifier) | Telegram 발송 성공률 > 99%, 금지어 검출 0건, 인라인 키보드 동작 |
| Phase 6 (Web — Auth) | 3단계 권한 회원가입·로그인·미들웨어 라우팅 완료, RLS 정책 검증 |
| Phase 7 (Web — Read) | dashboard, watchlist, reports 페이지 모든 권한별로 정상 조회 |
| Phase 8 (Web — Edit) | mapping, knowledge, weights 페이지 admin 편집 기능 + audit log |
| Phase 9 (Web — Backtest) | 백테스트 실행 + Recharts 시각화 + Storage signed URL 다운로드 |
| Phase 10 (Web — Admin) | 사용자 관리·데이터 품질·알림 로그 대시보드 |
| Phase 11 (통합) | 텔레그램 `/link` 코드 연동, 웹↔텔레그램 양방향 동작 |

---

*Last updated: 2026-05-05*
