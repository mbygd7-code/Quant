"""StockScorer — combine 7 sub-scores into a final 0-1 signal.

Implements SKILL.md section 3:

    final_score =
          0.20 * global_market_score
        + 0.20 * sector_score
        + 0.20 * related_us_stock_score
        + 0.15 * news_sentiment_score
        + 0.10 * fundamental_score
        + 0.10 * volume_flow_score
        - 0.05 * risk_penalty

Weight values come from the active row in `weight_configs` so admins can
re-tune via the web UI without touching code (Prompt 08 web edit).
"""
from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import date as Date
from datetime import timedelta

from cognition.__schemas__.scoring import AIScore, Rationale, SignalLabel, SubScores
from cognition.mapper import calculate_related_us_score
from db.supabase_client import get_admin_client

log = logging.getLogger("cognition.scorer")

NEUTRAL = 0.5
SUBSCORE_SCALE = 50.0           # same as mapper — ±2% maps to ~0.73 / 0.27

# Sector → US ETF used as the sector signal proxy.
SECTOR_PROXIES: dict[str, list[str]] = {
    "반도체":     ["SOXX", "^SOX"],
    "2차전지":    ["LIT"],
    "자동차":     ["F", "GM"],         # OEM proxy when no auto ETF available
    "바이오/헬스": ["XBI"],
    "인터넷/AI":  ["XLK"],
}

GLOBAL_INDICES = ["^IXIC", "^GSPC", "^SOX"]
GLOBAL_INDEX_WEIGHTS = {"^IXIC": 0.4, "^GSPC": 0.35, "^SOX": 0.25}


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


@dataclass
class WeightConfig:
    # Eight subscore weights — original 7 + kr_fear_greed (8th factor).
    # Defaults sum to 1.0; the migration that introduced the 8th column
    # renormalizes existing rows so old configs keep summing to 1.0.
    global_market: float = 0.19
    sector: float = 0.19
    related_us_stock: float = 0.19
    news_sentiment: float = 0.14
    fundamental: float = 0.10
    volume_flow: float = 0.09
    risk_penalty: float = 0.05
    kr_fear_greed: float = 0.05
    threshold_strong: float = 0.80
    threshold_interest: float = 0.65
    threshold_neutral: float = 0.50
    threshold_caution: float = 0.35


class StockScorer:
    """Build one AIScore per (ticker, date)."""

    def __init__(self, weights: WeightConfig | None = None):
        self._weights = weights or self._load_active_weights()

    def score(self, ticker: str, on_date: Date) -> AIScore:
        sub = self._compute_sub_scores(ticker, on_date)
        final = self._combine(sub)
        signal = self._to_signal(final)
        return AIScore(
            date=on_date,
            ticker=ticker,
            final_score=final,
            signal=signal,
            sub_scores=sub,
            rationale=self._build_stub_rationale(sub),
        )

    # ──────────────────────────────────────────────────────
    # Sub-score computation (each returns 0-1; default to NEUTRAL on missing data)
    # ──────────────────────────────────────────────────────
    def _compute_sub_scores(self, ticker: str, on_date: Date) -> SubScores:
        return SubScores(
            global_market=self._global_market(ticker, on_date),
            sector=self._sector(ticker, on_date),
            related_us_stock=calculate_related_us_score(ticker, on_date),
            news_sentiment=self._news(ticker, on_date),
            fundamental=self._fundamental(ticker, on_date),
            volume_flow=self._volume_flow(ticker, on_date),
            risk_penalty=self._risk(ticker, on_date),
            kr_fear_greed=self._kr_fear_greed(on_date),
        )

    def _kr_fear_greed(self, on_date: Date) -> float:
        """8th factor — KR-specific Fear & Greed composite (0..1).

        The underlying compute returns 0..100; we divide. Note this is
        market-wide (not per-ticker) so it's cached per `on_date` to
        avoid recomputing the watchlist breadth/foreign-flow scan for
        every ticker in a single scoring run.
        """
        cached = getattr(self, "_kr_fg_cache", {})
        if on_date in cached:
            return cached[on_date]
        try:
            from signals.kr_fear_greed import compute_kr_fg

            result = compute_kr_fg(on_date)
            value = max(0.0, min(1.0, result.score / 100.0))
        except Exception as exc:
            log.warning("kr_fear_greed compute failed (%s) — using NEUTRAL", exc)
            value = NEUTRAL
        cached[on_date] = value
        self._kr_fg_cache = cached
        return value

    def _global_market(self, ticker: str, on_date: Date) -> float:
        """Combined global signal:
            (a) Weighted % change of major US indices (NDX/SPX/SOX/VIX/DJI/RUT)
            (b) Layer-3 macro contribution: ticker-specific β × today's
                macro factor change (USDKRW, ^TNX, ^VIX, DXY, WTI), pulled
                from kr_macro_betas. β captures whether this stock benefits
                from KRW weakness, suffers from rising yields, etc.

        Both signals enter the same sigmoid so the result still maps to
        [0, 1]. `ticker=""` (legacy callers) bypasses the macro term.
        """
        sb = get_admin_client()
        since = (on_date - timedelta(days=10)).isoformat()
        rows = (
            sb.table("global_market")
              .select("date, symbol, change_rate")
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .in_("symbol", GLOBAL_INDICES)
              .order("date", desc=True)
              .execute()
              .data
        ) or []
        # Pick the latest row per index symbol from the window.
        latest_per: dict[str, dict] = {}
        for r in rows:
            if r["symbol"] not in latest_per:
                latest_per[r["symbol"]] = r
        if not latest_per:
            return NEUTRAL
        weighted = 0.0
        denom = 0.0
        for sym, row in latest_per.items():
            chg = row.get("change_rate")
            if chg is None:
                continue
            w = GLOBAL_INDEX_WEIGHTS.get(sym, 0.0)
            weighted += float(chg) * w
            denom += w
        index_avg = (weighted / denom) if denom else 0.0

        # Layer-3 macro contribution (per-ticker)
        macro_contribution = self._macro_contribution(ticker, on_date) if ticker else 0.0

        if denom == 0 and macro_contribution == 0.0:
            return NEUTRAL
        # Both terms are already in "% change" scale; sum then sigmoid.
        return sigmoid((index_avg + macro_contribution) * SUBSCORE_SCALE)

    def _macro_contribution(self, ticker: str, on_date: Date) -> float:
        """Per-ticker macro factor contribution for the global signal.

        Σ β_i × Δfactor_i, capped at ±0.05 (=5%) to keep one runaway
        macro variable from dominating the entire signal. Ignores betas
        with R² < 0.05 (statistical noise floor).
        """
        sb = get_admin_client()
        beta_rows = (
            sb.table("kr_macro_betas")
              .select("macro_factor, beta, r_squared")
              .eq("kr_ticker", ticker)
              .execute()
              .data
        ) or []
        if not beta_rows:
            return 0.0
        factors = [r["macro_factor"] for r in beta_rows
                   if (r.get("r_squared") or 0) >= 0.05]
        if not factors:
            return 0.0

        # Latest macro change at-or-before on_date
        since = (on_date - timedelta(days=10)).isoformat()
        macro_rows = (
            sb.table("global_market")
              .select("date, symbol, change_rate")
              .gte("date", since).lte("date", on_date.isoformat())
              .in_("symbol", factors)
              .not_.is_("change_rate", "null")
              .order("date", desc=True)
              .execute()
              .data
        ) or []
        latest_macro: dict[str, float] = {}
        for r in macro_rows:
            sym = r["symbol"]
            if sym not in latest_macro:
                latest_macro[sym] = float(r["change_rate"])

        contribution = 0.0
        for r in beta_rows:
            factor = r["macro_factor"]
            if (r.get("r_squared") or 0) < 0.05:
                continue
            chg = latest_macro.get(factor)
            if chg is None:
                continue
            contribution += float(r["beta"]) * chg

        return max(-0.05, min(0.05, contribution))

    def _sector(self, ticker: str, on_date: Date) -> float:
        """Sector signal blending two sources (Layer-2 of mapping system):
          (1) SECTOR_PROXIES — average change_rate of US peer-stocks
          (2) Sector ETF — β-weighted change_rate of best-fitting ETF
              (kr_sector_betas, computed via 60-day rolling OLS)

        ETF β captures sector-wide flows that individual peer-stocks miss
        (e.g., a SOXX rally on China-easing news lifts every KR semi
        even when NVDA is flat). When both signals are available, blend
        them 50/50; otherwise fall back to whichever is present.
        """
        sector = self._lookup_sector(ticker)
        if sector is None:
            return NEUTRAL
        sb = get_admin_client()
        since = (on_date - timedelta(days=10)).isoformat()

        # ── (1) US peer-stock proxies ──────────────────────────
        proxies = SECTOR_PROXIES.get(sector, [])
        proxy_signal: float | None = None
        if proxies:
            rows = (
                sb.table("global_market")
                  .select("date, symbol, change_rate")
                  .gte("date", since)
                  .lte("date", on_date.isoformat())
                  .in_("symbol", proxies)
                  .order("date", desc=True)
                  .execute()
                  .data
            ) or []
            latest_per: dict[str, dict] = {}
            for r in rows:
                latest_per.setdefault(r["symbol"], r)
            changes = [
                float(r["change_rate"]) for r in latest_per.values()
                if r.get("change_rate") is not None
            ]
            if changes:
                avg = sum(changes) / len(changes)
                proxy_signal = sigmoid(avg * SUBSCORE_SCALE)

        # ── (2) Sector ETF β-weighted prediction ───────────────
        etf_signal: float | None = None
        beta_rows = (
            sb.table("kr_sector_betas")
              .select("etf_symbol, beta, r_squared")
              .eq("kr_ticker", ticker)
              .order("r_squared", desc=True)
              .limit(1)
              .execute()
              .data
        ) or []
        if beta_rows and beta_rows[0].get("r_squared") is not None and beta_rows[0]["r_squared"] >= 0.05:
            best = beta_rows[0]
            etf_sym = best["etf_symbol"]
            etf_recent = (
                sb.table("global_market")
                  .select("date, change_rate")
                  .gte("date", since)
                  .lte("date", on_date.isoformat())
                  .eq("symbol", etf_sym)
                  .order("date", desc=True)
                  .limit(1)
                  .execute()
                  .data
            ) or []
            if etf_recent and etf_recent[0].get("change_rate") is not None:
                etf_change = float(etf_recent[0]["change_rate"])
                # predicted KR return = β × ETF return
                predicted = float(best["beta"]) * etf_change
                etf_signal = sigmoid(predicted * SUBSCORE_SCALE)

        # ── Blend ───────────────────────────────────────────────
        signals = [s for s in (proxy_signal, etf_signal) if s is not None]
        if not signals:
            return NEUTRAL
        return sum(signals) / len(signals)

    def _news(self, ticker: str, on_date: Date) -> float:
        """Mean news sentiment over the last 3 days at-or-before `on_date`.

        For KR tickers, we don't have a KR-news collector yet — Finnhub covers
        only US sources. Fall back to the sentiment of mapped US symbols
        (us_kr_mapping) weighted by impact_strength: this reuses the same
        signal that drives related_us_stock_score, but on the *narrative*
        axis instead of the price axis.
        """
        sb = get_admin_client()
        since = (on_date - timedelta(days=3)).isoformat()

        # 1) Direct: any news_items already tagged with this ticker.
        rows = (
            sb.table("news_items")
              .select("sentiment_score, related_symbols, date")
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .contains("related_symbols", [ticker])
              .not_.is_("sentiment_score", "null")
              .execute()
              .data
        ) or []
        direct = [float(r["sentiment_score"]) for r in rows if r.get("sentiment_score") is not None]
        if direct:
            return sum(direct) / len(direct)

        # 2) Fallback for KR tickers: weighted sentiment of mapped US symbols.
        if not (ticker.isdigit() and len(ticker) == 6):
            return NEUTRAL                                      # not a KR ticker
        mappings = (
            sb.table("us_kr_mapping")
              .select("us_symbol, impact_strength")
              .eq("kr_ticker", ticker)
              .execute()
              .data
        ) or []
        if not mappings:
            return NEUTRAL
        us_syms = [m["us_symbol"] for m in mappings]
        rows = (
            sb.table("news_items")
              .select("sentiment_score, related_symbols, date")
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .overlaps("related_symbols", us_syms)
              .not_.is_("sentiment_score", "null")
              .execute()
              .data
        ) or []
        if not rows:
            return NEUTRAL
        weight_by_sym = {m["us_symbol"]: float(m["impact_strength"]) for m in mappings}
        weighted = 0.0
        denom = 0.0
        for r in rows:
            score = float(r["sentiment_score"])
            for sym in (r.get("related_symbols") or []):
                if sym in weight_by_sym:
                    w = weight_by_sym[sym]
                    weighted += score * w
                    denom += w
                    break
        return (weighted / denom) if denom else NEUTRAL

    def _fundamental(self, ticker: str, on_date: Date) -> float:
        """Sector-relative percentile blend of 4 metrics:
          1. forwardPE     (lower = better)  — kr_fundamentals (yfinance)
          2. ROE           (higher = better) — kr_fundamentals (yfinance)
          3. revenue YoY   (higher = better) — kr_financials (DART)
          4. op_income YoY (higher = better) — kr_financials (DART)

        Each metric is percentile-ranked within the same sector. Final
        score = mean of available ranks (a ticker missing some metrics
        still gets fair points from the rest). NEUTRAL when fewer than 3
        sector peers have any data.
        """
        sector = self._lookup_sector(ticker)
        if sector is None:
            return NEUTRAL

        sb = get_admin_client()
        peers_rows = (
            sb.table("stocks").select("ticker")
              .eq("sector", sector).eq("is_watchlist", True)
              .execute().data
        ) or []
        peer_tickers = [r["ticker"] for r in peers_rows]
        if len(peer_tickers) < 3:
            return NEUTRAL

        # 1) yfinance daily fundamentals (forward_pe, roe)
        since = (on_date - timedelta(days=21)).isoformat()
        fund_rows = (
            sb.table("kr_fundamentals")
              .select("date, ticker, forward_pe, roe")
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .in_("ticker", peer_tickers)
              .order("date", desc=True)
              .execute()
              .data
        ) or []
        fund_latest: dict[str, dict] = {}
        for r in fund_rows:
            fund_latest.setdefault(r["ticker"], r)

        # 2) DART quarterly financials (revenue_yoy, op_income_yoy)
        fin_rows = (
            sb.table("kr_financials")
              .select("ticker, period_end, revenue_yoy, op_income_yoy")
              .in_("ticker", peer_tickers)
              .order("period_end", desc=True)
              .execute()
              .data
        ) or []
        fin_latest: dict[str, dict] = {}
        for r in fin_rows:
            fin_latest.setdefault(r["ticker"], r)

        ranks: list[float] = []
        for source, key, lower_better in (
            (fund_latest, "forward_pe",     True),
            (fund_latest, "roe",            False),
            (fin_latest,  "revenue_yoy",    False),
            (fin_latest,  "op_income_yoy",  False),
        ):
            my_row = source.get(ticker)
            if my_row is None or my_row.get(key) is None:
                continue
            my_value = float(my_row[key])
            if key == "forward_pe" and my_value <= 0:
                continue                                       # loss-making, meaningless P/E
            peers_with_data = [
                (t, float(r[key])) for t, r in source.items()
                if r.get(key) is not None
                and (key != "forward_pe" or float(r[key]) > 0)
            ]
            if len(peers_with_data) < 3:
                continue
            sorted_pairs = sorted(
                peers_with_data, key=lambda x: x[1], reverse=not lower_better,
            )
            for i, (tkr, _) in enumerate(sorted_pairs):
                if tkr == ticker:
                    ranks.append(1.0 - (i / max(len(sorted_pairs) - 1, 1)))
                    break

        if not ranks:
            return NEUTRAL
        return sum(ranks) / len(ranks)

    def _volume_flow(self, ticker: str, on_date: Date) -> float:
        """Net-buy or volume z-score on the most recent trading day at-or-
        before `on_date`, normalized by rolling stddev over the 45-day window.

        Preferred metric: foreign + institution net buy (KRX-specific signal).
        Fallback: total volume — when foreign/institution columns are NULL
        (e.g. yfinance backfill, pykrx unavailable). Lookback is wide enough
        to keep the 5-sample baseline after a few-day gap.
        """
        sb = get_admin_client()
        since = (on_date - timedelta(days=45)).isoformat()
        rows = (
            sb.table("korea_market")
              .select("date, volume, foreign_net_buy, institution_net_buy")
              .eq("ticker", ticker)
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .execute()
              .data
        ) or []
        if not rows:
            return NEUTRAL
        # Latest = max date in the window (rows ordered ascending below).
        rows_sorted = sorted(rows, key=lambda r: r["date"])
        latest = rows_sorted[-1]

        # Choose metric: net-buy if any sample has it, else fall back to volume.
        has_netbuy = any(
            r.get("foreign_net_buy") is not None or r.get("institution_net_buy") is not None
            for r in rows_sorted
        )
        if has_netbuy:
            extract = lambda r: (r.get("foreign_net_buy") or 0) + (r.get("institution_net_buy") or 0)
        else:
            extract = lambda r: (r.get("volume") or 0)

        latest_value = extract(latest)
        history = [extract(r) for r in rows_sorted[:-1]]
        if len(history) < 5:
            return NEUTRAL
        mean = sum(history) / len(history)
        variance = sum((v - mean) ** 2 for v in history) / len(history)
        stddev = math.sqrt(variance) or 1.0
        z = (latest_value - mean) / stddev
        # z = +2 → 0.88, -2 → 0.12. Clip via sigmoid.
        return sigmoid(z)

    def _risk(self, ticker: str, on_date: Date) -> float:
        """Higher = more risk. Combines (a) most recent change_rate magnitude
        within the window and (b) 5-day rolling stddev of close. Returns [0, 1]."""
        sb = get_admin_client()
        since = (on_date - timedelta(days=21)).isoformat()
        rows = (
            sb.table("korea_market")
              .select("date, close, change_rate")
              .eq("ticker", ticker)
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .order("date", desc=False)
              .execute()
              .data
        ) or []
        if len(rows) < 5:
            return NEUTRAL
        latest = rows[-1]
        latest_chg = abs(float(latest.get("change_rate") or 0))     # 0..1
        closes = [float(r["close"]) for r in rows if r.get("close")]
        if len(closes) < 5:
            return NEUTRAL
        mean = sum(closes) / len(closes)
        variance = sum((c - mean) ** 2 for c in closes) / len(closes)
        cv = math.sqrt(variance) / mean if mean else 0.0           # coefficient of variation
        # Combined risk: 50% of latest |change|, 50% of CV. CV typically 0.01-0.05.
        risk = 0.5 * min(latest_chg / 0.05, 1.0) + 0.5 * min(cv / 0.05, 1.0)
        return min(max(risk, 0.0), 1.0)

    # ──────────────────────────────────────────────────────
    # Combine + map to signal
    # ──────────────────────────────────────────────────────
    def _combine(self, sub: SubScores) -> float:
        w = self._weights
        # NOTE on related_us_stock: a 16-day diagnostic suggested it was a
        # same-day ANTI-signal (Spearman ρ≈-0.27) — US gains pricing into the
        # KR open via gap-up, then mean-reverting. We briefly subtracted it,
        # but plain subtraction un-centers the weighted average (a fully
        # neutral 0.5 input dropped from 0.45 → 0.26), which silently biased
        # every signal bearish. 16 days is too thin to justify that, so we've
        # reverted to the normalized positive term. The weekly diagnostic
        # (model_diagnostics) is accumulating evidence; once ≥30-60 days
        # confirm the anti-signal we'll invert it the *correct* way that
        # preserves centering: `+ w.related_us_stock * (1 - sub.related_us_stock)`.
        raw = (
            w.global_market * sub.global_market
            + w.sector * sub.sector
            + w.related_us_stock * sub.related_us_stock
            + w.news_sentiment * sub.news_sentiment
            + w.fundamental * sub.fundamental
            + w.volume_flow * sub.volume_flow
            + w.kr_fear_greed * sub.kr_fear_greed
            - w.risk_penalty * sub.risk_penalty
        )
        return min(max(raw, 0.0), 1.0)

    def _to_signal(self, final: float) -> SignalLabel:
        w = self._weights
        if final >= w.threshold_strong:
            return "강한 관심"
        if final >= w.threshold_interest:
            return "관심"
        if final >= w.threshold_neutral:
            return "관망"
        if final >= w.threshold_caution:
            return "주의"
        return "위험"

    # ──────────────────────────────────────────────────────
    # Stub rationale (replaced by LLM in Prompt 07)
    # ──────────────────────────────────────────────────────
    def _build_stub_rationale(self, sub: SubScores) -> Rationale:
        ranked = sorted(
            [
                ("global_market", sub.global_market),
                ("sector", sub.sector),
                ("related_us_stock", sub.related_us_stock),
                ("news_sentiment", sub.news_sentiment),
                ("volume_flow", sub.volume_flow),
            ],
            key=lambda kv: -kv[1],
        )
        top3 = ranked[:3]
        evidence = [
            f"{name} 점수 {value:.2f} ({'긍정' if value > 0.55 else '중립'})"
            for name, value in top3
        ]
        risks = [
            f"리스크 점수 {sub.risk_penalty:.2f} (단기 변동성/과열 평가)",
            f"펀더멘털 데이터 부족 (현재 {sub.fundamental:.2f} 중립 처리)",
        ]
        return Rationale(evidence=evidence, risks=risks, sub_scores=sub)

    # ──────────────────────────────────────────────────────
    # DB lookups
    # ──────────────────────────────────────────────────────
    def _lookup_sector(self, ticker: str) -> str | None:
        sb = get_admin_client()
        row = (
            sb.table("stocks")
              .select("sector")
              .eq("ticker", ticker)
              .limit(1)
              .execute()
              .data
        )
        if not row:
            return None
        return row[0].get("sector")

    @staticmethod
    def _load_active_weights() -> WeightConfig:
        sb = get_admin_client()
        rows = (
            sb.table("weight_configs")
              .select("*")
              .eq("is_active", True)
              .limit(1)
              .execute()
              .data
        ) or []
        if not rows:
            log.warning("No active weight_configs row — using defaults")
            return WeightConfig()
        r = rows[0]
        return WeightConfig(
            global_market=float(r["global_market_weight"]),
            sector=float(r["sector_weight"]),
            related_us_stock=float(r["related_us_stock_weight"]),
            news_sentiment=float(r["news_sentiment_weight"]),
            fundamental=float(r["fundamental_weight"]),
            volume_flow=float(r["volume_flow_weight"]),
            risk_penalty=float(r["risk_penalty_weight"]),
            # 8th weight — missing on rows from before migration 25.
            # Fall back to dataclass default (0.05) so old configs keep
            # working until they're rewritten by the admin UI.
            kr_fear_greed=float(r.get("kr_fear_greed_weight", 0.05)),
            threshold_strong=float(r["signal_threshold_strong"]),
            threshold_interest=float(r["signal_threshold_interest"]),
            threshold_neutral=float(r["signal_threshold_neutral"]),
            threshold_caution=float(r["signal_threshold_caution"]),
        )


def upsert_score(score: AIScore) -> None:
    """Persist one AIScore to ai_scores (overwrite on conflict)."""
    sb = get_admin_client()
    row = {
        "date":                   score.date.isoformat(),
        "ticker":                 score.ticker,
        "global_market_score":    score.sub_scores.global_market,
        "sector_score":           score.sub_scores.sector,
        "related_us_stock_score": score.sub_scores.related_us_stock,
        "news_sentiment_score":   score.sub_scores.news_sentiment,
        "fundamental_score":      score.sub_scores.fundamental,
        "volume_flow_score":      score.sub_scores.volume_flow,
        "risk_penalty":           score.sub_scores.risk_penalty,
        "kr_fear_greed_score":    score.sub_scores.kr_fear_greed,
        "final_score":            score.final_score,
        "signal":                 score.signal,
        "rationale_json":         score.rationale.model_dump(),
    }
    sb.table("ai_scores").upsert(row, on_conflict="date,ticker").execute()
