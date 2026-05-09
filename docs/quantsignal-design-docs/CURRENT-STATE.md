# 📍 QuantSignal — 현재 상태 분석 (M1 시작 전)

> **작성일**: 2026-05-09
> **목적**: 8명 AI 캐릭터 시스템 도입 전, 기존 인프라의 *건드리면 안 되는 경계선*을 명확히 한다.
> **원칙**: Strangler Fig. 신규 코드는 옆에 추가, 검증 후에만 기존 대체.

---

## 1. Python 의존성 (`pyproject.toml`)

GitHub Actions runner용 풀 셋. Vercel은 별도 trim된 `apps/api/requirements.txt` 사용.

| 카테고리 | 패키지 | 비고 |
|---|---|---|
| **Supabase / DB** | `supabase>=2.7,<3`, `psycopg[binary]>=3.2,<4`, `redis>=5,<6` | RLS 우회용 admin client는 `db/supabase_client.py` |
| **AI** | `anthropic>=0.34,<1`, `openai>=1.40,<2` | Claude Sonnet 4.6 + text-embedding-3-small |
| **데이터 소스** | `pykrx`, `yfinance`, `finnhub-python`, `edgartools`, `pandas-market-calendars` | Vercel에 import 금지 (250MB 빌드 한도) |
| **ML** | `scikit-learn>=1.5`, `numpy>=1.26,<3`, `pandas>=2.2,<3` | Simons GBM에 직접 사용 예정 |
| **시각화** | `matplotlib`, `plotly` | 백테스트 PNG/HTML |
| **파이프라인** | `apscheduler`, `tenacity`, `httpx`, `pyyaml`, `pydantic>=2.9,<3` | |
| **Vercel 측** | `fastapi>=0.115`, `mangum>=0.17` | ASGI adapter |
| **알림** | `python-telegram-bot[ext]>=21.6` | webhook + polling |
| **로컬 호환** | `tzdata>=2024.1` | Windows ZoneInfo("Asia/Seoul") |

**Vercel `apps/api/requirements.txt`** (250MB 한도 trim):
- `fastapi`, `pydantic[email]`, `supabase`, `mangum`, `httpx`, `python-telegram-bot[ext]`, `redis`, `pyjwt`
- ❌ scikit-learn / pykrx / edgartools / finnhub-python / pandas — **금지**

**Dev tooling**: ruff, mypy, pytest, pytest-asyncio, pytest-mock

---

## 2. Frontend 의존성 (`apps/web/package.json`)

**프레임워크**: Next.js 14.2.35 (App Router), React 18, TypeScript 5

**핵심**:
- Supabase: `@supabase/supabase-js@2.105`, `@supabase/ssr@0.10`
- 상태/폼: `@tanstack/react-query@5.100`, `react-hook-form@7.75`, `zod@4`
- UI: `tailwindcss@3.4` + Radix primitives 7종 (dialog, dropdown, label, select, slider, slot, tabs)
- 차트: `recharts@3.8`
- 에디터: `@uiw/react-md-editor` (RAG 청크 편집)
- 아이콘: `lucide-react@1.14`
- 토스트: `sonner@2.0`
- 임베딩: `openai@6.36`

---

## 3. 환경변수 파일 상태

| 파일 | 존재 | 라인 수 |
|---|:-:|---:|
| `/.env` | ❌ | — |
| `/.env.local` | ❌ | — |
| `/.env.example` | ✅ | 66 |
| `/apps/web/.env.local` | ✅ | 16 (실제 키 보유) |
| `/apps/api/.env` | ❌ | — |

**프론트엔드 키** (16개): Supabase URL/Anon/Service Role, NEXT_PUBLIC_FINNHUB_KEY, ANTHROPIC_API_KEY, DART_API_KEY, ALPHA_VANTAGE_KEY, DEV_BYPASS_AUTH, NEXT_PUBLIC_APP_URL — 자세한 키 이름은 [배포 문서] 참고.

**Vercel 프로덕션**: 위 키들이 production/preview/development 환경별로 주입됨. `DEV_BYPASS_AUTH`는 preview/development만 (production 절대 금지).

> 보안 주의: 실제 값은 본 문서에 절대 포함하지 않음. M1 단계에서 Anthropic API 직접 호출 래퍼(`callClaude`) 추가 시 `ANTHROPIC_API_KEY` 사용.

---

## 4. Supabase 연결 설정

### Python 측 (`db/supabase_client.py`)
```python
get_admin_client()  # service_role — RLS 우회, 백엔드 전용
get_anon_client()   # 사용자 노출 가능 (Phase 2)
```

CLAUDE.md §3-E 준수: Service Role Key는 클라이언트에 절대 노출 금지. lru_cache로 싱글턴.

### TypeScript 측 (`apps/web/lib/supabase/`)
- `client.ts` — Browser client (Anon Key)
- `server.ts` — Server Component client
- `middleware.ts` — 세션 갱신 + 권한 라우팅
- `query-client.ts` — DEV_BYPASS_AUTH 감지 → service_role 사용

### 마이그레이션 디렉토리 (`supabase/migrations/`)

**명명 규칙**: `00000000000NNN_<주제>.sql` (13자리 zero-padded prefix + snake_case 주제)

기존 17개 (M1 신규 테이블은 `00000000000018_*` 부터):

| # | 파일 | 핵심 |
|---:|---|---|
| 01 | `_extensions.sql` | pgvector 등 |
| 02 | `_core_tables.sql` | stocks, korea_market, us_kr_mapping, ai_scores, news |
| 03 | `_executor_tables.sql` | broker_orders, paper_positions |
| 04 | `_user_tables.sql` | profiles, user_watchlists, audit_logs |
| 05 | `_rls_policies.sql` | RLS 전면 적용 |
| 06 | `_rpc_functions.sql` | 서버 RPC |
| 07 | `_triggers.sql` | updated_at 자동 갱신 |
| 08 | `_seed_weight_config.sql` | 7요소 가중치 (기존 — 8명 시스템과 별개) |
| 09 | `_foreign_keys.sql` | 후행 FK |
| 10 | `_invite_role_promotion.sql` | beta 초대 |
| 11 | `_link_telegram_conflict.sql` | telegram_chat_id 연동 |
| 12 | `_kr_fundamentals.sql` | 재무지표 |
| 13 | `_kr_dart_financials.sql` | DART 공시 |
| 14 | `_sector_betas_ai_commentary.sql` | 섹터 베타 + AI 코멘트 |
| 15 | `_score_predictions.sql` | GBM 예측 결과 |
| 16 | `_macro_betas.sql` | 매크로 변수 베타 |
| 17 | `_market_briefs.sql` | 일일 시장 브리프 |

**주의**: `_seed_weight_config.sql` (08)에 *기존 7요소 가중치*가 이미 있음. 8명 시스템의 새 가중치는 **별도 테이블**로 분리해야 충돌 없음 (`user_weight_settings`, `weight_settings_history` 신설).

**시드**: `supabase/seed/01_stocks.sql`, `02_us_kr_mapping.sql`

---

## 5. 기존 7단계 파이프라인 (보존 영역)

> ⚠️ **M1~M9 동안 이 파일들은 절대 수정하지 않는다**. 8명 캐릭터는 *위*에 새로 만들고, 검증 후에만 기존 호출부를 교체한다.

### 폴더 구조 + 파일 인벤토리

```
collectors/                                [GitHub Actions]
├── _base.py                  # 공통 베이스
├── dart.py                   # 한국 공시
├── finnhub.py                # 미국 시세·뉴스
├── krx.py                    # KRX (yfinance fallback)
├── __schemas__/              # Pydantic 스키마
└── utils/business_days.py    # 영업일 계산

refinery/                                  [GitHub Actions]
├── (전 모듈 — 14.45% 오류 폐기 정책)
└── utils/

cognition/                                 [GitHub Actions]
├── commentary.py             # AI 코멘트
├── embedder.py               # text-embedding-3-small
├── mapper.py                 # US-KR 매핑
├── market_brief.py           # 시장 브리프
├── scorer.py                 # 7요소 종합 점수 (기존 시스템)
├── scorer_cli.py
├── sentiment.py              # Claude 감성 분석
├── sentiment_cli.py
├── rag/chunks/               # RAG 지식 베이스
└── __schemas__/

signals/                                   [GitHub Actions]
├── backtest.py               # 백테스트
├── backtest_status.py
├── features.py               # 피처 엔지니어링
├── gbm.py                    # GradientBoostingClassifier ★ M5에서 Simons가 활용
├── gbm_cli.py
├── preview_report.py
├── report.py                 # Claude 리포트 + 금지어 검증
├── score_regressor.py
└── __schemas__/

executor/                                  [GitHub Actions, Phase 1=Paper만]
├── broker_interface.py       # 추상 베이스
├── paper_broker.py           # 가상매매 (구현됨)
├── kis_broker.py             # NotImplementedError stub
├── kiwoom_broker.py          # NotImplementedError stub
├── safety.py                 # EXECUTION_MODE 가드
└── __schemas__/

orchestrator/
├── pipeline.py               # 일일 파이프라인 마스터 (Step 0-5)
└── health_check.py

notifier/                                  [공유]
├── bot_runner.py             # Telegram polling (로컬 dev)
├── dispatcher.py
├── kakao.py
├── markdown.py
├── telegram.py
├── telegram_handlers.py
└── __schemas__/

db/
└── supabase_client.py        # admin/anon 팩토리

apps/
├── api/                      # FastAPI Vercel Serverless
│   ├── index.py              # 진입점
│   └── routes/
│       ├── admin.py
│       ├── backtest.py
│       ├── notifications.py
│       ├── telegram_webhook.py
│       └── users.py
└── web/                      # Next.js 14
    ├── app/                  # 라우트 (auth/app/admin 그룹)
    ├── components/
    └── lib/
```

### M1에서 만져도 되는 영역 vs 안 되는 영역

| 영역 | M1 가능 여부 | 비고 |
|---|:-:|---|
| `supabase/migrations/00000000000018_*` 이후 | ✅ 신규 추가 | 8명 캐릭터 테이블 |
| `apps/web/app/(admin)/weights/` 옆에 신설 | ✅ 신규 페이지 | 8명 가중치 슬라이더 (기존 7요소 페이지는 보존) |
| `apps/web/lib/agents/` 신설 | ✅ 새 폴더 | callClaude 래퍼, 캐릭터 어댑터 |
| `apps/web/app/api/agents/` 신설 | ✅ 신규 라우트 | 8명 시스템 전용 엔드포인트 |
| `cognition/scorer.py` (기존 7요소) | ❌ | 보존 — Soros가 *옆에* 새 가중 합산 만듦 |
| `signals/gbm.py` | ❌ M5까지 | M5에서 Simons가 *읽어가는* 형태로만 사용 |
| `orchestrator/pipeline.py` | ❌ | 8명 사이클은 별도 entry-point (cron job 분리) |
| `db/supabase_client.py` | ❌ | 그대로 사용, 새 클라이언트 추가 X |

---

## 6. 배포 인프라 (작동 중)

| 영역 | 위치 | 상태 |
|---|---|---|
| Web + API | Vercel `quant` 프로젝트 (rootDir `apps/web`, framework Next.js) | ✅ Production: `https://quant-amnxq0zod-baeyoung-myungs-projects.vercel.app` |
| FastAPI (apps/api) | 미배포 — vercel.json 제거 후 보류 | M1 이후 별도 작업으로 부활 예정 |
| 일일 파이프라인 | `.github/workflows/daily-pipeline.yml` (cron) | 작동 중 |
| Supabase | yanzpasrpzppcmlrxyjp.supabase.co | 17개 마이그레이션 적용됨 |

**git push → Vercel 자동 배포**가 활성화되어 있음 — M1 작업 시 푸시만으로 미리보기 동시 갱신.

---

## 7. M1에서 *반드시 통과해야 할* 회귀 테스트

기존 운영 시스템이 영향 없는지 확인하는 베이스라인:

- [ ] `/dashboard` `/watchlist` `/reports` `/settings` 정상 렌더 (DEV_BYPASS_AUTH=true 모드)
- [ ] `/stocks/kr` 4개 카드 + NAVER live snapshot 정상
- [ ] `/realtime` Finnhub WebSocket LIVE
- [ ] `/admin/weights` (기존 7요소 가중치 페이지) 정상 — **8명 시스템과 분리 보존**
- [ ] `/admin/mapping` `/admin/knowledge` `/admin/backtest` admin only 작동
- [ ] `npx tsc --noEmit` typecheck pass
- [ ] `pytest -q` (Python) — 기존 테스트 통과
- [ ] Supabase 마이그레이션 17개 모두 적용 상태 유지

---

## 8. 8명 캐릭터 시스템과 기존 시스템의 관계

```
[기존]
collectors → refinery → cognition.scorer (7요소) → signals.report → notifier
                                  ↓
                            ai_scores 테이블 (보존)

[신설, M1 이후]
                                  ↓ (읽기 전용)
                     agent_outputs (8명 출력 통합)
                            ↓ (Soros가 종합)
                       final_signals (신규)
                            ↓
                       daily_briefings (신규)
                            ↓
                  [신규 알림 채널 또는 기존 dispatcher 재활용]
```

**핵심**: 기존 `ai_scores`는 *읽기 전용* 데이터로 8명 시스템에 공급됨. 기존 알림(Telegram preview)은 그대로 작동, M6에서 *옆에* 신규 UI 추가.

---

## 9. 결론 — M1 시작 가능 상태 ✅

- 모든 의존성 정합 (Python 3.11 + Node 18+)
- Supabase 17개 마이그레이션 정상
- 환경변수 인프라 정리 완료
- Vercel 자동 배포 활성화
- 기존 운영 코드 식별 완료 (보존 대상 명확)

**다음 단계**: `M1-WORK-PLAN.md` 의 첫 번째 작업부터 시작.
