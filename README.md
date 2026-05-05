# QuantSignal

> 미국장 마감 후 ~ 한국장 시작 전 90분 동안, 글로벌 선행 신호를 한국 관심 50종목 단위로 번역해
> **5등급 신호** (강한 관심 / 관심 / 관망 / 주의 / 위험) 를 Telegram 또는 카카오톡으로 발송하는
> AI 투자 판단 보조 시스템.
>
> 자동매매 봇이 아닙니다. 모든 신호에는 (1) 근거 3개 + (2) 리스크 2개가 동반되며,
> 면책 문구가 항상 표시됩니다. 자세한 행동 규칙은 `CLAUDE.md`, 스키마·정책은 `SKILL.md` 참고.

---

## 아키텍처 한 눈에

```
GitHub (monorepo)
├── apps/web/   ──────► Vercel (Next.js 14 + MeetFlow 디자인)
├── apps/api/   ──────► Vercel (FastAPI Serverless, /api/*)
└── .github/workflows/
    ├── ci.yml             — lint + test (PR/push)
    ├── migrate.yml        — supabase db push
    ├── daily-pipeline.yml — 매일 06:00 KST cron
    └── backtest.yml       — 사용자 트리거 (workflow_dispatch)

GitHub Actions Runner ──► collectors → refinery → cognition → signal → notify
                                          │
                         Supabase (Postgres + pgvector + Auth + Storage)
```

3개 인프라 — **GitHub + Vercel + Supabase**. Railway·VPS 미사용.

---

## 사전 준비 (한 번만)

### A. Supabase
1. https://supabase.com → New Project (Region: Northeast Asia (Seoul))
2. Database password 안전하게 보관
3. **Database → Extensions → `vector` 활성화**
4. **Storage**: 다음 3개 버킷 생성, 모두 **Private**
   - `raw-api-backups`, `backtest-reports`, `daily-reports`
5. **Settings → API**: URL · anon key · service_role key 복사
6. **Account → Access Tokens**: GitHub Actions용 토큰 발급

### B. Telegram
1. `@BotFather` (파란 체크 ✓ 확인) → `/newbot` → 봇 토큰 받기
2. 본인 봇과 `/start` 1회 → `@userinfobot` → chat_id 확인
3. Webhook secret 생성:
   ```powershell
   -join ((1..32) | ForEach-Object { [char[]]'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-' | Get-Random })
   ```

### C. API 키
- Anthropic (https://console.anthropic.com) — Claude Sonnet 4.7
- OpenAI (https://platform.openai.com) — `text-embedding-3-small`
- Finnhub (https://finnhub.io) — free tier OK
- DART (https://opendart.fss.or.kr) — Phase 3 공시 수집 시 필요

### D. GitHub Secrets
저장소 → Settings → Secrets and variables → Actions → Repository secrets:

| 시크릿 | 비고 |
|---|---|
| `SUPABASE_PROJECT_REF`        | 프로젝트 URL의 서브도메인 |
| `SUPABASE_ACCESS_TOKEN`       | `sbp_...` (Account → Access Tokens) |
| `SUPABASE_DB_PASSWORD`        | 프로젝트 생성 시 입력한 패스워드 |
| `SUPABASE_URL`                | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY`   | RLS 우회 — 백엔드 전용 |
| `ANTHROPIC_API_KEY`           | |
| `OPENAI_API_KEY`              | |
| `FINNHUB_API_KEY`             | |
| `DART_API_KEY`                | (Phase 3) |
| `TELEGRAM_BOT_TOKEN`          | |
| `TELEGRAM_ADMIN_CHAT_ID`      | 운영자 본인 |
| `TELEGRAM_WEBHOOK_SECRET`     | 32자 랜덤 |

### E. Vercel
1. https://vercel.com → New Project → 본 저장소 선택
2. **Root Directory**: `apps/web` (Next.js 자동 감지)
3. Environment Variables: `.env.example`의 모든 키 등록
4. ⚠️ Prompt 13에서 `apps/web/`을 채우기 전까지는 첫 빌드가 실패합니다 (정상)

### F. GitHub PAT (Vercel → workflow_dispatch 호출용)
1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained**
2. Repository access: 본 저장소만 / Permissions: Actions(read+write), Contents(read), Metadata(read)
3. Vercel Variables 에 등록:
   - `GITHUB_REPO=<owner>/Quant`
   - `GITHUB_PAT=<발급된 토큰>`

---

## 로컬 개발

```bash
# 1) Supabase CLI 설치 (Mac/Linux)
brew install supabase/tap/supabase
# Windows: scoop install supabase  또는  npm i -g supabase

# 2) 프로젝트 링크
supabase link --project-ref <ref>

# 3) 마이그레이션 적용 (로컬 → 원격)
supabase db push

# 4) 시드 데이터 삽입 — Supabase Dashboard → SQL Editor에서 실행
#    supabase/seed/01_stocks.sql
#    supabase/seed/02_us_kr_mapping.sql

# 5) Python 환경
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

# 6) 환경변수
cp .env.example .env                # 값 채우기

# 7) 파이프라인 단발 실행
python -m orchestrator.pipeline --mode=once --date=today
```

---

## 운영

| 작업 | 주체 | 트리거 |
|---|---|---|
| 코드 배포 (web + api) | Vercel | `main` push 시 자동 |
| DB 마이그레이션 | GitHub Actions | `main` + `supabase/migrations/**` 변경 시 |
| Daily Pipeline | GitHub Actions | 매일 06:00 KST cron |
| 수동 파이프라인 | GitHub Actions | Actions 탭 → Daily Pipeline → Run workflow |
| 백테스트 | GitHub Actions | apps/api → workflow_dispatch (Phase 9 웹 UI) |
| Telegram Webhook 등록 | 1회만 (Vercel 첫 배포 후) | 아래 명령 |

### Telegram Webhook 등록 (배포 직후 1회)

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://<vercel-domain>/api/telegram/webhook" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

확인:
```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

---

## 디렉토리 구조

| 경로 | 실행 환경 | 역할 |
|---|---|---|
| `collectors/`        | GitHub Actions  | 외부 API 호출 (KRX, Finnhub, EDGAR, DART) |
| `refinery/`          | GitHub Actions  | Pydantic 검증·정제 (14.45% 폐기율 가정) |
| `cognition/`         | GitHub Actions  | LLM·임베딩·매핑·점수 산출 |
| `signals/`            | GitHub Actions  | ML 모델·백테스트·리포트 생성 |
| `executor/`          | GitHub Actions  | PaperBroker (실거래는 Phase 3 승인 후) |
| `orchestrator/`      | GitHub Actions  | 파이프라인 조립·진입점 |
| `notifier/`          | 공유            | Telegram 메시지 포맷터 |
| `db/`                | 공유            | Supabase / Storage 클라이언트 |
| `apps/api/`          | Vercel          | FastAPI (Telegram Webhook + 가벼운 API) |
| `apps/web/`          | Vercel          | Next.js 14 (MeetFlow 디자인 — Prompt 13) |
| `supabase/migrations/` | GitHub Actions | DB 스키마 (`supabase db push`) |
| `supabase/seed/`     | 수동 (SQL Editor) | 50종목 + 매핑 시드 |
| `.github/workflows/` | GitHub Actions  | CI / Migration / Daily Pipeline / Backtest |
| `tests/`             | GitHub Actions  | pytest |

각 폴더는 다른 폴더의 내부 구현을 import하지 않으며, `__init__.py` 인터페이스만 사용합니다.

---

## Phase 진행 현황

- [x] **Phase 0** — Bootstrap (Prompt 01) — 본 커밋
- [ ] **Phase 1** — Collectors (Prompt 02)
- [ ] **Phase 2** — Refinery (Prompt 03)
- [ ] **Phase 3** — Cognition (Prompt 04)
- [ ] **Phase 4** — Signal (Prompt 05)
- [ ] **Phase 5** — Notifier (Prompt 06)
- [ ] **Phase 6~10** — Web App (Prompt 07~12)
- [ ] **Phase 11** — 통합 (Prompt 13)

---

## 안전 장치 (CLAUDE.md §3)

- **금지어** ("매수", "확정", "보장", "100%" 등)는 `signals/report.py`에서 자동 검증, 발견 시 ValueError raise
- **모든 LLM 호출**: ① system prompt ② few-shot 3개 이상 ③ structured output (Pydantic) 강제
- **EXECUTION_MODE**가 `report_only` 또는 `paper`가 아니면 파이프라인 시작 거부 (`orchestrator/pipeline.py`)
- **Service Role Key**는 백엔드(GitHub Actions / FastAPI Server-side) 전용. 클라이언트 노출 절대 금지
- **모든 사용자 데이터 테이블**에 RLS 정책 적용 (`supabase/migrations/00000000000005_rls_policies.sql`)

---

## 문서

- `CLAUDE.md` — 프로젝트 헌법 (행동 규칙 + ABSOLUTE RULES)
- `SKILL.md` — 스키마 + API 매트릭스 + US-KR 매핑 + 가중 공식
- `PROMPTS.md` — Claude Code 순차 프롬프트 (Prompt 01~13)
- `CHANGELOG.md` — 변경 이력

---

*Last updated: 2026-05-05*
