"""Feature engineering for the GBM next-day-up classifier (SKILL.md section 8).

14 features per (ticker, date) row, all numeric:

  Global (yesterday US session):
    us_nasdaq_change, us_sp500_change, us_sox_change,
    vix, us_10y_yield, dxy, usdkrw, wti

  Related US (mapping-weighted):
    related_us_avg_change

  Korea (yesterday KR session):
    kr_close_change, kr_volume_zscore,
    foreign_net_5d, institution_net_5d

  News:
    news_sentiment_avg, news_count

Missing values are filled with the column median to keep the GBM stable.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import date as Date
from datetime import timedelta

from db.supabase_client import get_admin_client

log = logging.getLogger("signals.features")

FEATURE_NAMES: list[str] = [
    "us_nasdaq_change",
    "us_sp500_change",
    "us_sox_change",
    "vix",
    "us_10y_yield",
    "dxy",
    "usdkrw",
    "wti",
    "related_us_avg_change",
    "kr_close_change",
    "kr_volume_zscore",
    "foreign_net_5d",
    "institution_net_5d",
    "news_sentiment_avg",
    "news_count",
]


@dataclass
class FeatureRow:
    ticker: str
    on_date: Date
    values: dict[str, float] = field(default_factory=dict)

    def as_array(self) -> list[float]:
        """Order-preserving: returns a list aligned with FEATURE_NAMES."""
        return [self.values.get(name, 0.0) for name in FEATURE_NAMES]


# ──────────────────────────────────────────────────────────
# Builder — pulls everything via Supabase. Tests pass `db` mock.
# ──────────────────────────────────────────────────────────
class FeatureBuilder:
    def __init__(self, db=None) -> None:
        self._db = db or get_admin_client()

    def build(self, ticker: str, on_date: Date) -> FeatureRow:
        row = FeatureRow(ticker=ticker, on_date=on_date)
        row.values.update(self._global_features(on_date))
        row.values.update(self._korea_features(ticker, on_date))
        row.values.update(self._news_features(ticker, on_date))
        row.values["related_us_avg_change"] = self._related_us_avg(ticker, on_date)
        return row

    def _global_features(self, on_date: Date) -> dict[str, float]:
        symbols = ["^IXIC", "^GSPC", "^SOX", "^VIX", "DXY", "USDKRW"]
        rows = (
            self._db.table("global_market")
                .select("symbol, change_rate, close")
                .eq("date", on_date.isoformat())
                .in_("symbol", symbols)
                .execute()
                .data
        ) or []
        idx = {r["symbol"]: r for r in rows}
        return {
            "us_nasdaq_change": _change(idx.get("^IXIC")),
            "us_sp500_change":  _change(idx.get("^GSPC")),
            "us_sox_change":    _change(idx.get("^SOX")),
            "vix":              _close(idx.get("^VIX")),
            "us_10y_yield":     0.0,         # not collected yet; fill in Phase 2
            "dxy":              _close(idx.get("DXY")),
            "usdkrw":           _close(idx.get("USDKRW")),
            "wti":              0.0,         # not collected yet
        }

    def _korea_features(self, ticker: str, on_date: Date) -> dict[str, float]:
        since = (on_date - timedelta(days=10)).isoformat()
        rows = (
            self._db.table("korea_market")
                .select("date, close, volume, change_rate, "
                        "foreign_net_buy, institution_net_buy")
                .eq("ticker", ticker)
                .gte("date", since)
                .lte("date", on_date.isoformat())
                .order("date", desc=False)
                .execute()
                .data
        ) or []
        if not rows:
            return {"kr_close_change": 0.0, "kr_volume_zscore": 0.0,
                    "foreign_net_5d": 0.0, "institution_net_5d": 0.0}

        latest = rows[-1]
        history = rows[:-1] if len(rows) > 1 else []

        kr_close_change = float(latest.get("change_rate") or 0)
        volumes = [float(r["volume"]) for r in history if r.get("volume")]
        if volumes:
            mean = sum(volumes) / len(volumes)
            var = sum((v - mean) ** 2 for v in volumes) / len(volumes)
            stddev = var ** 0.5 or 1.0
            volume_z = (float(latest.get("volume") or 0) - mean) / stddev
        else:
            volume_z = 0.0

        last_5 = rows[-5:]
        foreign_5d = sum(float(r.get("foreign_net_buy") or 0) for r in last_5)
        inst_5d = sum(float(r.get("institution_net_buy") or 0) for r in last_5)

        return {
            "kr_close_change":    kr_close_change,
            "kr_volume_zscore":   volume_z,
            "foreign_net_5d":     foreign_5d,
            "institution_net_5d": inst_5d,
        }

    def _news_features(self, ticker: str, on_date: Date) -> dict[str, float]:
        rows = (
            self._db.table("news_items")
                .select("sentiment_score, related_symbols")
                .eq("date", on_date.isoformat())
                .contains("related_symbols", [ticker])
                .execute()
                .data
        ) or []
        scores = [float(r["sentiment_score"]) for r in rows
                  if r.get("sentiment_score") is not None]
        return {
            "news_sentiment_avg": (sum(scores) / len(scores)) if scores else 0.5,
            "news_count":          float(len(rows)),
        }

    def _related_us_avg(self, ticker: str, on_date: Date) -> float:
        mappings = (
            self._db.table("us_kr_mapping")
                .select("us_symbol, impact_strength")
                .eq("kr_ticker", ticker)
                .execute()
                .data
        ) or []
        if not mappings:
            return 0.0
        symbols = [m["us_symbol"] for m in mappings]
        rows = (
            self._db.table("global_market")
                .select("symbol, change_rate")
                .eq("date", on_date.isoformat())
                .in_("symbol", symbols)
                .execute()
                .data
        ) or []
        idx = {r["symbol"]: float(r["change_rate"]) for r in rows
               if r.get("change_rate") is not None}
        weighted = sum(idx.get(m["us_symbol"], 0.0) * float(m["impact_strength"])
                       for m in mappings)
        denom = sum(float(m["impact_strength"]) for m in mappings)
        return weighted / denom if denom else 0.0


def _change(row: dict | None) -> float:
    return float(row["change_rate"]) if row and row.get("change_rate") is not None else 0.0


def _close(row: dict | None) -> float:
    return float(row["close"]) if row and row.get("close") is not None else 0.0
