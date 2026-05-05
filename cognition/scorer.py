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
    global_market: float = 0.20
    sector: float = 0.20
    related_us_stock: float = 0.20
    news_sentiment: float = 0.15
    fundamental: float = 0.10
    volume_flow: float = 0.10
    risk_penalty: float = 0.05
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
            global_market=self._global_market(on_date),
            sector=self._sector(ticker, on_date),
            related_us_stock=calculate_related_us_score(ticker, on_date),
            news_sentiment=self._news(ticker, on_date),
            fundamental=self._fundamental(ticker, on_date),
            volume_flow=self._volume_flow(ticker, on_date),
            risk_penalty=self._risk(ticker, on_date),
        )

    def _global_market(self, on_date: Date) -> float:
        sb = get_admin_client()
        rows = (
            sb.table("global_market")
              .select("symbol, change_rate")
              .eq("date", on_date.isoformat())
              .in_("symbol", GLOBAL_INDICES)
              .execute()
              .data
        ) or []
        if not rows:
            return NEUTRAL
        weighted = 0.0
        denom = 0.0
        for row in rows:
            chg = row.get("change_rate")
            if chg is None:
                continue
            w = GLOBAL_INDEX_WEIGHTS.get(row["symbol"], 0.0)
            weighted += float(chg) * w
            denom += w
        return sigmoid((weighted / denom) * SUBSCORE_SCALE) if denom else NEUTRAL

    def _sector(self, ticker: str, on_date: Date) -> float:
        sector = self._lookup_sector(ticker)
        if sector is None:
            return NEUTRAL
        proxies = SECTOR_PROXIES.get(sector, [])
        if not proxies:
            return NEUTRAL
        sb = get_admin_client()
        rows = (
            sb.table("global_market")
              .select("symbol, change_rate")
              .eq("date", on_date.isoformat())
              .in_("symbol", proxies)
              .execute()
              .data
        ) or []
        if not rows:
            return NEUTRAL
        avg = sum(float(r["change_rate"]) for r in rows if r.get("change_rate") is not None) / len(rows)
        return sigmoid(avg * SUBSCORE_SCALE)

    def _news(self, ticker: str, on_date: Date) -> float:
        """Mean sentiment of news_items mentioning `ticker` on `on_date`."""
        sb = get_admin_client()
        rows = (
            sb.table("news_items")
              .select("sentiment_score, related_symbols")
              .eq("date", on_date.isoformat())
              .contains("related_symbols", [ticker])
              .not_.is_("sentiment_score", "null")
              .execute()
              .data
        ) or []
        scores = [float(r["sentiment_score"]) for r in rows if r.get("sentiment_score") is not None]
        if not scores:
            return NEUTRAL
        return sum(scores) / len(scores)

    def _fundamental(self, ticker: str, on_date: Date) -> float:
        # Phase 2 placeholder per PROMPTS.md.
        return NEUTRAL

    def _volume_flow(self, ticker: str, on_date: Date) -> float:
        """Foreign + institution net buy normalized by 20-day rolling stddev."""
        sb = get_admin_client()
        # Look back 20 trading days for stddev baseline.
        since = (on_date - timedelta(days=30)).isoformat()
        rows = (
            sb.table("korea_market")
              .select("date, foreign_net_buy, institution_net_buy")
              .eq("ticker", ticker)
              .gte("date", since)
              .lte("date", on_date.isoformat())
              .execute()
              .data
        ) or []
        if not rows:
            return NEUTRAL
        latest = next((r for r in rows if r["date"] == on_date.isoformat()), None)
        if not latest:
            return NEUTRAL
        latest_total = (latest.get("foreign_net_buy") or 0) + (latest.get("institution_net_buy") or 0)

        history = [
            (r.get("foreign_net_buy") or 0) + (r.get("institution_net_buy") or 0)
            for r in rows if r["date"] != on_date.isoformat()
        ]
        if len(history) < 5:
            return NEUTRAL
        mean = sum(history) / len(history)
        variance = sum((v - mean) ** 2 for v in history) / len(history)
        stddev = math.sqrt(variance) or 1.0
        z = (latest_total - mean) / stddev
        # z = +2 → 0.88, -2 → 0.12. Clip via sigmoid.
        return sigmoid(z)

    def _risk(self, ticker: str, on_date: Date) -> float:
        """Higher = more risk. Combines (a) recent change_rate magnitude
        and (b) 5-day rolling stddev of close. Returns [0, 1]."""
        sb = get_admin_client()
        since = (on_date - timedelta(days=14)).isoformat()
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
        raw = (
            w.global_market * sub.global_market
            + w.sector * sub.sector
            + w.related_us_stock * sub.related_us_stock
            + w.news_sentiment * sub.news_sentiment
            + w.fundamental * sub.fundamental
            + w.volume_flow * sub.volume_flow
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
        "final_score":            score.final_score,
        "signal":                 score.signal,
        "rationale_json":         score.rationale.model_dump(),
    }
    sb.table("ai_scores").upsert(row, on_conflict="date,ticker").execute()
