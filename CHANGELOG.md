# Changelog

All notable changes to QuantSignal are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Version: [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pending
- Telegram webhook registration on the deployed Vercel URL (one-time):
  `VERCEL_DEPLOYMENT_URL=... python scripts/setup_telegram_webhook.py`
- First Daily Pipeline manual trigger via GitHub Actions UI
- `apps/web/` Next.js scaffold with MeetFlow design (Prompt 13)


## [0.1.0] — 2026-05-05 — Beta backend ready

First end-to-end runnable backend. 50 KR watchlist tickers, daily
pre-market pipeline (collectors → refinery → cognition → signal →
notifier), Telegram bot delivery, paper trading, and on-demand
walk-forward backtest. CLAUDE.md §3-A safety (forbidden words, no
recommendations, disclaimer) enforced at the report layer.

### Added — by Prompt
- **Prompt 01 — Bootstrap.** Folder tree, Supabase 8 migrations, seed
  (50 stocks + US-KR mapping), shared db/ clients, vercel.json,
  4 GitHub workflows (ci, migrate, daily-pipeline, backtest).
- **Prompt 02 — Collectors.** KrxCollector (50 watchlist OHLCV + foreign/
  institution net buy via pykrx), FinnhubCollector (17 equities + 6
  indices + 2 FX + per-ticker 24h news, asyncio + pacing for free tier).
  pandas-market-calendars for KR/US business-day math.
- **Prompt 03 — Refinery.** BaseRefiner with 14.45% discard simulation,
  KrxRefiner (OHLC consistency + ±30% change cap + ticker FK +
  date+ticker merge), FinnhubRefiner (asset-class change caps + URL
  dedup + length filter). Discarded rows archived to Storage.
- **Prompt 04 — Cognition: Sentiment.** SentimentEngine with Anthropic
  forced tool_use (record_sentiment), 5-bucket label, daily LLM cap
  (LLM_DAILY_CAP, default 200), Redis-or-InMemory cache, OpenAI
  text-embedding-3-small wrapper.
- **Prompt 05 — Cognition: Mapper + RAG.** sigmoid-weighted US→KR score
  (scale=50), 25 investment-thesis YAML chunks (semiconductor 6 +
  battery 5 + auto 5 + bio 4 + internet 5), embedder + retriever via
  match_rag_chunks RPC.
- **Prompt 06 — Scorer + GBM.** StockScorer with 7-factor weighted final
  score (SKILL.md §3) backed by active weight_configs row, signal
  5-bucket mapping, GBM next-day-up classifier with TimeSeriesSplit CV.
- **Prompt 07 — Report Generator.** ReportGenerator with 4 few-shot
  examples (강한 관심 / 관망 / 주의 / 위험), forbidden-word post-
  validation + retry (3 attempts), disclaimer auto-append. preview_report
  daily 50-stock markdown.
- **Prompt 08 — Telegram Bot.** TelegramNotifier (MarkdownV2 escape +
  4096-char split + plain-text fallback), 9 commands (/start /link
  /today /stock /sector /top /risk /feedback /help), 8 callback patterns,
  KakaoNotifier Phase 2 stub, NotificationDispatcher with retry + audit
  log. Vercel webhook + local polling, setup script.
- **Prompt 09 — Executor.** PaperBroker on Supabase (paper_trades +
  paper_portfolio), 10M KRW initial capital, immediate fill at last
  close or limit price, KIS/Kiwoom Phase 3 stubs, EXECUTION_MODE
  guard (allow only report_only / paper).
- **Prompt 10 — Orchestrator + Backtest + Admin API.** Full async
  pipeline.run_once with 5 best-effort steps, walk-forward Backtest
  (3 strategies, sharpe + drawdown + matplotlib equity curve to
  Storage), backtest_status CLI, admin endpoints (data-quality, cost,
  notifications log, backtest status).

### Operations
- **Daily pipeline:** GitHub Actions cron `0 21 * * 0-4` (06:00 KST).
- **Backtest:** apps/api → workflow_dispatch → backtest.yml runner.
- **Telegram beta:** Webhook on Vercel `apps/api/routes/telegram_webhook.py`.
- **Paper trading:** EXECUTION_MODE=paper. Live trading (kis_real /
  kiwoom_real) deliberately blocked until Phase 3 user approval.

### Safety (CLAUDE.md sections A/B/C/D enforced)
- **Forbidden words** (매수/매도/강력 추천/오늘 오른다/확정/보장/100%) blocked
  in `signals/__schemas__/report.py` with retry + ReportSkipped fallback.
- **14.45% discard target** in `refinery/_base.py`; WARN log outside band.
- **Daily LLM cap** in `cognition/utils/cost_tracker.py`.
- **Pydantic v2 strict validation** at every collector → refinery →
  cognition → signals interface boundary; failures discarded, never
  silently corrected.
- **Service Role Key** never reaches client code paths
  (`db/supabase_client.py` admin-only).

### Monitoring
- GitHub Actions tab — pipeline + backtest run history
- Vercel Dashboard — apps/web + apps/api deployment + runtime logs
- Supabase Dashboard — DB / Storage / Auth usage
- Telegram admin chat — failure alerts (notifier.dispatcher → admin alert)
- Anthropic / OpenAI dashboards — LLM spend

### Known limitations
- `apps/web/` empty (Prompt 13 scaffolds with MeetFlow design)
- `DART_API_KEY` not yet wired (Phase 3 disclosure collection)
- Test mock for paper-trading Supabase queries kept in test file
  (no real DB integration test yet)


## Test growth by Prompt

| Prompt | New tests | Cumulative |
|---|---|---|
| 01 Bootstrap         | —      | 0   |
| 02 Collectors        | 18     | 18  |
| 03 Refinery          | 17     | 35  |
| 04 Sentiment         | 20     | 55  |
| 05 Mapper + RAG      | 21     | 76  |
| 06 Scorer + GBM      | 24     | 100 |
| 07 Report Generator  | 21     | 121 |
| 08 Telegram Bot      | 46     | 167 |
| 09 Executor          | 28     | 195 |
| 10 Orchestrator+BT   | 31     | 226 |
