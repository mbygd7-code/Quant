"""Walk-forward backtest harness.

Reads ai_scores rows in [start, end] from Supabase, simulates buying every
ticker matching `strategy` at the next trading day's open, and exits after
`holding_days` at the open. Returns per-trade records + aggregate metrics
and (optionally) uploads a matplotlib equity-curve PNG to Storage.

CLI:
    python -m signals.backtest --start=2025-11-01 --end=2026-04-30 \\
        --strategy=score_above_065 [--job-id=<uuid>]
"""
from __future__ import annotations

import argparse
import io
import logging
import math
import sys
from datetime import date as Date
from datetime import datetime, timedelta

from db.storage_client import upload_backtest_artifact
from db.supabase_client import get_admin_client
from signals.__schemas__.backtest import (
    BacktestParams,
    BacktestSummary,
    Strategy,
    TradeRecord,
)

log = logging.getLogger("signals.backtest")

DEFAULT_TRADING_DAYS_PER_YEAR = 252
PROGRESS_REPORT_EVERY = 50


# ──────────────────────────────────────────────────────────
# Strategy filters — return list of tickers to enter on a given date
# ──────────────────────────────────────────────────────────
STRATEGY_FILTERS: dict[Strategy, callable] = {
    "score_above_065": lambda rows: [r for r in rows if r["final_score"] >= 0.65],
    "strong_only":      lambda rows: [r for r in rows if r["signal"] == "강한 관심"],
    "top5_per_day":     lambda rows: sorted(rows, key=lambda r: -r["final_score"])[:5],
}


class Backtest:
    def __init__(
        self,
        params: BacktestParams,
        *,
        job_id: str | None = None,
        db=None,
    ) -> None:
        self.params = params
        self.job_id = job_id
        self._db = db or get_admin_client()
        self.strategy_id = (
            f"{params.strategy}__{params.start_date.isoformat()}_{params.end_date.isoformat()}"
        )

    # ──────────────────────────────────────────────────────
    # Public
    # ──────────────────────────────────────────────────────
    def run(self) -> tuple[list[TradeRecord], BacktestSummary]:
        ai_scores_by_date = self._load_ai_scores()
        market = self._load_market_data()
        sector_by_ticker = self._load_sectors()
        trading_days = sorted(market.keys())

        if not trading_days:
            raise RuntimeError("No korea_market data in the requested range.")

        trades: list[TradeRecord] = []
        for entry_idx, entry_day in enumerate(trading_days):
            score_rows = ai_scores_by_date.get(self._previous_score_date(entry_day, ai_scores_by_date))
            if not score_rows:
                continue
            picks = STRATEGY_FILTERS[self.params.strategy](score_rows)
            exit_idx = entry_idx + self.params.holding_days
            if exit_idx >= len(trading_days):
                break
            exit_day = trading_days[exit_idx]
            for row in picks:
                trade = self._simulate_trade(
                    score_row=row,
                    entry_day=entry_day,
                    exit_day=exit_day,
                    market=market,
                )
                if trade:
                    trades.append(trade)
            self._maybe_report_progress(len(trades))

        summary = self._summarize(trades, sector_by_ticker)
        self._persist(trades, summary)
        return trades, summary

    # ──────────────────────────────────────────────────────
    # DB loaders
    # ──────────────────────────────────────────────────────
    def _load_ai_scores(self) -> dict[Date, list[dict]]:
        # Walk-forward: signal generated on day D used to enter on day D+1.
        rows = (
            self._db.table("ai_scores")
                .select("date, ticker, signal, final_score")
                .gte("date", self.params.start_date.isoformat())
                .lte("date", self.params.end_date.isoformat())
                .execute()
                .data
        ) or []
        by_date: dict[Date, list[dict]] = {}
        for row in rows:
            d = Date.fromisoformat(row["date"])
            by_date.setdefault(d, []).append(row)
        return by_date

    def _load_market_data(self) -> dict[Date, dict[str, dict]]:
        # Need a few days past end_date for exits.
        end_buf = self.params.end_date + timedelta(days=14)
        rows = (
            self._db.table("korea_market")
                .select("date, ticker, open, close")
                .gte("date", self.params.start_date.isoformat())
                .lte("date", end_buf.isoformat())
                .execute()
                .data
        ) or []
        by_date: dict[Date, dict[str, dict]] = {}
        for row in rows:
            d = Date.fromisoformat(row["date"])
            by_date.setdefault(d, {})[row["ticker"]] = row
        return by_date

    def _load_sectors(self) -> dict[str, str]:
        rows = (
            self._db.table("stocks").select("ticker, sector").execute().data
        ) or []
        return {r["ticker"]: (r.get("sector") or "기타") for r in rows}

    # ──────────────────────────────────────────────────────
    # Per-trade simulation
    # ──────────────────────────────────────────────────────
    def _simulate_trade(
        self,
        *,
        score_row: dict,
        entry_day: Date,
        exit_day: Date,
        market: dict[Date, dict[str, dict]],
    ) -> TradeRecord | None:
        ticker = score_row["ticker"]
        entry_row = market.get(entry_day, {}).get(ticker)
        exit_row = market.get(exit_day, {}).get(ticker)
        if not entry_row or not exit_row:
            return None
        entry_price = int(entry_row.get("open") or 0)
        exit_price = int(exit_row.get("open") or 0)
        if entry_price <= 0 or exit_price <= 0:
            return None
        gross_return = (exit_price - entry_price) / entry_price
        # Round-trip commission (in/out) — single number subtracted once.
        net_return = gross_return - (self.params.commission_bps / 10_000.0)
        return TradeRecord(
            strategy_id=self.strategy_id,
            date=entry_day,
            ticker=ticker,
            signal=score_row["signal"],
            entry_price=entry_price,
            exit_price=exit_price,
            actual_return=net_return,
            hit=net_return > 0,
        )

    @staticmethod
    def _previous_score_date(entry_day: Date, scores: dict[Date, list[dict]]) -> Date | None:
        # Most recent score date strictly before entry_day.
        candidates = sorted(d for d in scores if d < entry_day)
        return candidates[-1] if candidates else None

    # ──────────────────────────────────────────────────────
    # Aggregation
    # ──────────────────────────────────────────────────────
    def _summarize(
        self, trades: list[TradeRecord], sector_by_ticker: dict[str, str],
    ) -> BacktestSummary:
        if not trades:
            return BacktestSummary(
                strategy_id=self.strategy_id,
                start_date=self.params.start_date,
                end_date=self.params.end_date,
                trade_count=0, win_count=0, win_rate=0.0,
                avg_return=0.0, cumulative_return=0.0,
                sharpe_ratio=0.0, max_drawdown=0.0,
            )
        returns = [t.actual_return for t in trades]
        cumulative = 1.0
        equity_curve = [1.0]
        for r in returns:
            cumulative *= (1.0 + r)
            equity_curve.append(cumulative)

        wins = sum(1 for t in trades if t.hit)
        avg_r = sum(returns) / len(returns)
        # Daily Sharpe approximation: mean(returns) / stddev * sqrt(252)
        if len(returns) > 1:
            mean = avg_r
            var = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)
            std = math.sqrt(var) or 1e-9
            sharpe = (mean / std) * math.sqrt(DEFAULT_TRADING_DAYS_PER_YEAR)
        else:
            sharpe = 0.0
        max_dd = self._max_drawdown(equity_curve)

        by_signal = self._group_by(trades, lambda t: t.signal)
        by_sector = self._group_by(trades, lambda t: sector_by_ticker.get(t.ticker, "기타"))

        return BacktestSummary(
            strategy_id=self.strategy_id,
            start_date=self.params.start_date,
            end_date=self.params.end_date,
            trade_count=len(trades),
            win_count=wins,
            win_rate=wins / len(trades),
            avg_return=avg_r,
            cumulative_return=cumulative - 1.0,
            sharpe_ratio=sharpe,
            max_drawdown=max_dd,
            by_signal=by_signal,
            by_sector=by_sector,
        )

    @staticmethod
    def _max_drawdown(equity: list[float]) -> float:
        peak = equity[0]
        max_dd = 0.0
        for value in equity:
            if value > peak:
                peak = value
            drawdown = (value - peak) / peak
            if drawdown < max_dd:
                max_dd = drawdown
        return max_dd

    @staticmethod
    def _group_by(trades: list[TradeRecord], key) -> dict[str, dict[str, float]]:
        buckets: dict[str, list[TradeRecord]] = {}
        for t in trades:
            buckets.setdefault(key(t), []).append(t)
        out: dict[str, dict[str, float]] = {}
        for k, items in buckets.items():
            wins = sum(1 for t in items if t.hit)
            out[k] = {
                "count": float(len(items)),
                "win_rate": wins / len(items),
                "avg_return": sum(t.actual_return for t in items) / len(items),
            }
        return out

    # ──────────────────────────────────────────────────────
    # Persistence + plotting
    # ──────────────────────────────────────────────────────
    def _persist(self, trades: list[TradeRecord], summary: BacktestSummary) -> None:
        if trades:
            rows = [t.model_dump(mode="json") for t in trades]
            try:
                self._db.table("backtest_results").upsert(
                    rows, on_conflict="strategy_id,date,ticker",
                ).execute()
            except Exception as exc:
                log.warning("backtest_results upsert failed: %s", exc)

        if self.job_id:
            try:
                png_bytes = self._equity_curve_png(trades)
                upload_backtest_artifact(
                    self.job_id, "equity_curve.png",
                    png_bytes, content_type="image/png",
                )
            except Exception as exc:
                log.warning("equity_curve upload failed (non-fatal): %s", exc)
            self._update_job_status("completed", summary)

    @staticmethod
    def _equity_curve_png(trades: list[TradeRecord]) -> bytes:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        if not trades:
            fig = plt.figure(figsize=(8, 4))
            plt.text(0.5, 0.5, "No trades", ha="center", va="center")
            buf = io.BytesIO()
            fig.savefig(buf, format="png")
            plt.close(fig)
            return buf.getvalue()

        equity = [1.0]
        for t in trades:
            equity.append(equity[-1] * (1.0 + t.actual_return))
        fig, ax = plt.subplots(figsize=(8, 4))
        ax.plot(equity, linewidth=1.5)
        ax.set_title("Backtest Equity Curve")
        ax.set_xlabel("Trade #")
        ax.set_ylabel("Equity (start = 1.0)")
        ax.grid(alpha=0.3)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=120, bbox_inches="tight")
        plt.close(fig)
        return buf.getvalue()

    def _update_job_status(self, status: str, summary: BacktestSummary) -> None:
        try:
            self._db.table("backtest_jobs").update({
                "status": status,
                "progress": 100,
                "completed_at": datetime.utcnow().isoformat(),
                "result_url": f"{self.job_id}/equity_curve.png",
                "params": {**self.params.model_dump(mode="json"),
                           "summary": summary.model_dump(mode="json")},
            }).eq("id", self.job_id).execute()
        except Exception as exc:
            log.warning("job status update failed: %s", exc)

    def _maybe_report_progress(self, trades_so_far: int) -> None:
        if not self.job_id or trades_so_far == 0:
            return
        if trades_so_far % PROGRESS_REPORT_EVERY != 0:
            return
        try:
            # Coarse progress estimate — caps at 95% (final 5% is plotting + persist).
            pct = min(95, int(trades_so_far / 10))
            self._db.table("backtest_jobs").update({"progress": pct})\
                .eq("id", self.job_id).execute()
        except Exception:
            pass


# ──────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────
def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Walk-forward backtest")
    parser.add_argument("--start", required=True, help="YYYY-MM-DD")
    parser.add_argument("--end", required=True, help="YYYY-MM-DD")
    parser.add_argument("--strategy", default="score_above_065")
    parser.add_argument("--weight-config-id", default=None)
    parser.add_argument("--job-id", default=None,
                        help="backtest_jobs.id UUID (set by GitHub Actions trigger)")
    parser.add_argument("--holding-days", type=int, default=1)
    return parser.parse_args()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
        stream=sys.stdout,
    )
    args = _parse_args()
    params = BacktestParams(
        start_date=Date.fromisoformat(args.start),
        end_date=Date.fromisoformat(args.end),
        strategy=args.strategy,
        weight_config_id=args.weight_config_id,
        holding_days=args.holding_days,
    )
    bt = Backtest(params, job_id=args.job_id)
    _trades, summary = bt.run()
    log.info("Backtest done — %d trades, win=%.1f%%, cum_return=%.2f%%, sharpe=%.2f",
             summary.trade_count, summary.win_rate * 100,
             summary.cumulative_return * 100, summary.sharpe_ratio)
    return 0


if __name__ == "__main__":
    sys.exit(main())
