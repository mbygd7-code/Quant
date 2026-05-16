# Remaining Work — A~G Roadmap

Tracks the deferred portions of the "LNB-focused analysis + voter
expansion + UI cutover" initiative kicked off 2026-05-15.

**Completed in this session:**
- ✅ A: `user_favorites` table + server actions + localStorage mirror
- ✅ B: `--favorites-only` flag for run_m4_cycle + workflow integration
- ✅ C: LNB ↔ DB sync (covered by A's `useFavorites` rewire)
- ✅ D1: Turing voter (RSI + MACD + Bollinger) — 29 tests
- ✅ G (partial): `final_signals` reader + legacy fallback resolver

**Deferred — pick up next session:**

## D2 — Short-interest voter (공매도 잔량)

**Effort:** M (1 day)
**Expected accuracy lift:** +8%p
**Data source:** KRX `mdcstat/srt30001` (공매도잔고) — free, no key

### Tasks
1. `collectors/krx_shorting.py` — daily pull of `short_balance_qty`,
   `short_balance_value`, `short_balance_pct` per ticker
2. Migration 25: `kr_shorting` table (ticker, date, short_qty, short_value,
   short_pct, free_float_pct)
3. `scripts/backfill_krx_shorting.py` — 90-day history
4. `agents/characters/shorting.py` — voter named (reuse `simons` slot or
   add new agent_name to migration). Score from:
   - 5-day shorting trend acceleration (positive = bearish pressure)
   - shorting % of free float
   - day-over-day delta
5. Wire into M4_CHARACTER_ORDER
6. Tests: 25 cases on the calculator

## D3 — Earnings-surprise voter

**Effort:** L (2 days)
**Expected accuracy lift:** +10%p
**Data source:** FnGuide HTML scrape OR DART 공시 announcement events

### Tasks
1. `collectors/fnguide_consensus.py` — scrape consensus EPS/revenue per
   ticker (FnGuide blocks aggressive scraping — use 1s+ delay)
2. Migration 26: `kr_consensus` table (ticker, period_end, eps_consensus,
   revenue_consensus, source, fetched_at)
3. `agents/characters/earnings.py` — voter scoring:
   - Earnings surprise: (actual - consensus) / consensus
   - Revisions: 30-day consensus delta
   - Days-to-next-earnings (gating mechanism, similar to Taleb's D-7)
4. Tests + wire-in

## E — KR news collector

**Effort:** M (1 day)
**Expected accuracy lift:** +15%p
**Why critical:** `news_sentiment_score` is currently 0.50 default for
all KR stocks because cognition/scorer.py reads `news_items` which is
US-only. This single fix improves every voter's narrative quality.

### Tasks
1. `collectors/kr_news.py` — RSS pull from:
   - 한국경제 stocks RSS (per-section)
   - 매일경제 증권 RSS
   - 연합뉴스 경제 RSS
   - 네이버 금융 뉴스 API (`https://api.stock.naver.com/news/related?code=...`)
2. Migration 27: extend `news_items` with `lang` column + KR row support
3. `cognition/sentiment.py` — extend to handle Korean text (Claude
   handles ko natively, no separate model needed)
4. `cognition/scorer.py` line 283 comment removal + direct KR news path
5. Backfill 30 days history

## F — M5 GBM scaffolding

**Effort:** M (1 day)
**Expected accuracy lift:** TBD (requires ≥1000 ai_scores rows for
out-of-sample evaluation)

Already has plan doc at `docs/quantsignal-design-docs/M5-WORK-PLAN.md`.

### Tasks (skeleton ready, training deferred to data-rich state)
1. Verify `signals/gbm.py` MIN_TRAINING_ROWS=200 is reachable today
2. Add `--favorites-only` mode to `signals/backtest.py` so M5 evaluation
   matches production universe
3. Add `score_predictions` writer to daily-pipeline cron (currently
   manual script only)
4. CalibratedClassifierCV + GroupKFold by date (audit recommendation)
5. Walk-forward validation report → dashboard

## G — UI cutover completion

**Effort:** M (4 hours)
**Already done:**
- ✅ `lib/signal-resolver.ts` — grade ↔ Korean label mapping
- ✅ `lib/queries/watchlist.ts` — final_signals preferred, ai_scores fallback

### Still to do
1. `lib/queries/reports.ts` — same dual-read pattern for report pages
2. `lib/queries/dashboard.ts` — same for dashboard top/bottom 5
3. `app/(app)/stocks/kr/[ticker]/page.tsx` — fetch agent_outputs voter
   breakdown + render new VoterCards section (5 cards × Graham/Dow/
   Turing/Shiller/Keynes/Taleb)
4. New `components/signals/voter-breakdown.tsx` — horizontal bar of
   the 5 voter scores instead of the legacy 7-factor SubscoreBar
5. New `components/signals/taleb-badge.tsx` — show `taleb_severity` 4+
   prominently when override fires
6. Score-trend chart: update y-axis to handle confidence (0..1) OR
   weighted_score (-2..+2) consistently
7. Remove ai_commentary card OR adapt it to read final_signals.narrative
   (cleaner is single source: the Soros narrative on final_signals)
8. Delete legacy ai_scores writes from daily-pipeline.yml after the
   final_signals coverage exceeds 14 days history

## Cost projection after full A~G

| Stage | Daily LLM cost | Notes |
|-------|----------------|-------|
| Before (current) | $0.89 | 5 voters × 50 stocks |
| After A+B | $0.25 | -72% via favorites-only gating |
| + D1 (Turing) | $0.30 | +1 voter, but smaller cost than full universe expansion |
| + D2 + D3 + E | $0.45 | +2 voters + KR news enrichment |
| All A~G | $0.55 | 8 voters × ~25 stocks |

## Test coverage requirement

Each new voter MUST land with:
- 25+ math/score-mapper unit tests
- 1 integration test verifying it appears in `final_signals` after a
  single-ticker dry-run cycle
- Soros M4 synthesizer test re-pinned (`tests/agents/integration/
  test_m4_taleb_constraint.py` style)

## Migration application order

1. Apply migration 24 (user_favorites) to Supabase production
2. After 1 week of favorites data: enable `--favorites-only` cron
   default (already wired in agents-cycle.yml)
3. After 14+ days of final_signals data: switch ai_scores fallback off
   in queries/* — single source of truth.
