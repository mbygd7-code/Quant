"""preview_report — assemble the daily 50-stock summary markdown.

Produces a single markdown document with:
  - Header: date + 시장 온도 (Nasdaq, SOX, VIX, USDKRW)
  - Sector temperatures (count of 강한 관심 / 관심 / 관망 / 주의 / 위험 per sector)
  - Top 5 stocks by final_score
  - Risk watch: any ticker with signal in {주의, 위험}

Uploaded to Supabase Storage under daily-reports/{YYYY-MM-DD}/preview.md
and used as the body of the Telegram digest in Prompt 08.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import date as Date
from io import StringIO

from db.storage_client import upload_daily_report
from db.supabase_client import get_admin_client

log = logging.getLogger("signals.preview_report")

SIGNAL_EMOJI = {
    "강한 관심": "🟢", "관심": "🔵", "관망": "⚪",
    "주의":     "🟡", "위험": "🔴",
}


def build_preview_markdown(on_date: Date) -> str:
    sb = get_admin_client()
    scores = _fetch_scores(sb, on_date)
    market = _fetch_market_temp(sb, on_date)

    out = StringIO()
    out.write(f"# 📊 {on_date.isoformat()} 한국장 프리뷰\n\n")
    _write_market_temperature(out, market)
    _write_sector_temperatures(out, scores)
    _write_top_picks(out, scores)
    _write_risk_watch(out, scores)
    out.write(
        "\n---\n"
        "※ 본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.\n"
    )
    return out.getvalue()


def upload_preview(on_date: Date) -> str:
    """Build markdown then push to Storage. Returns the storage path."""
    markdown = build_preview_markdown(on_date)
    return upload_daily_report(on_date, "preview.md", markdown)


# ──────────────────────────────────────────────────────────
# Section writers
# ──────────────────────────────────────────────────────────
def _write_market_temperature(out: StringIO, market: dict[str, dict]) -> None:
    out.write("## 🌡 글로벌 온도\n\n")
    if not market:
        out.write("_시장 데이터 없음_\n\n")
        return
    headers = ["지표", "종가", "변동률"]
    out.write("| " + " | ".join(headers) + " |\n")
    out.write("|" + "|".join(["---"] * len(headers)) + "|\n")
    for symbol, row in market.items():
        chg = row.get("change_rate")
        chg_str = f"{chg * 100:+.2f}%" if chg is not None else "-"
        close = row.get("close")
        close_str = f"{close:,.2f}" if close is not None else "-"
        out.write(f"| {symbol} | {close_str} | {chg_str} |\n")
    out.write("\n")


def _write_sector_temperatures(out: StringIO, scores: list[dict]) -> None:
    out.write("## 🏭 섹터 온도\n\n")
    by_sector: dict[str, Counter] = {}
    for row in scores:
        sector = ((row.get("stocks") or {}).get("sector")) or "기타"
        by_sector.setdefault(sector, Counter())[row["signal"]] += 1
    if not by_sector:
        out.write("_섹터별 점수 없음_\n\n")
        return
    headers = ["섹터", "🟢", "🔵", "⚪", "🟡", "🔴"]
    out.write("| " + " | ".join(headers) + " |\n")
    out.write("|" + "|".join(["---"] * len(headers)) + "|\n")
    for sector, counter in sorted(by_sector.items()):
        out.write("| " + sector + " | " + " | ".join(
            str(counter.get(label, 0))
            for label in ("강한 관심", "관심", "관망", "주의", "위험")
        ) + " |\n")
    out.write("\n")


def _write_top_picks(out: StringIO, scores: list[dict]) -> None:
    top = sorted(scores, key=lambda r: -r["final_score"])[:5]
    out.write("## 🔝 상위 5 종목\n\n")
    if not top:
        out.write("_점수 데이터 없음_\n\n")
        return
    out.write("| 순위 | 신호 | 종목 | 점수 |\n|---|---|---|---|\n")
    for i, row in enumerate(top, start=1):
        emoji = SIGNAL_EMOJI.get(row["signal"], "⚪")
        name = ((row.get("stocks") or {}).get("name")) or row["ticker"]
        out.write(f"| {i} | {emoji} {row['signal']} | {name} ({row['ticker']}) | {row['final_score']:.2f} |\n")
    out.write("\n")


def _write_risk_watch(out: StringIO, scores: list[dict]) -> None:
    risky = [r for r in scores if r["signal"] in ("주의", "위험")]
    out.write(f"## ⚠️ 위험 신호 ({len(risky)} 종목)\n\n")
    if not risky:
        out.write("_위험·주의 신호 없음_\n\n")
        return
    risky.sort(key=lambda r: r["final_score"])
    out.write("| 신호 | 종목 | 점수 |\n|---|---|---|\n")
    for row in risky[:10]:
        emoji = SIGNAL_EMOJI.get(row["signal"], "⚠️")
        name = ((row.get("stocks") or {}).get("name")) or row["ticker"]
        out.write(f"| {emoji} {row['signal']} | {name} ({row['ticker']}) | {row['final_score']:.2f} |\n")
    out.write("\n")


# ──────────────────────────────────────────────────────────
# DB lookups
# ──────────────────────────────────────────────────────────
def _fetch_scores(sb, on_date: Date) -> list[dict]:
    rows = (
        sb.table("ai_scores")
          .select("ticker, signal, final_score, stocks(name, sector)")
          .eq("date", on_date.isoformat())
          .execute()
          .data
    )
    return rows or []


def _fetch_market_temp(sb, on_date: Date) -> dict[str, dict]:
    rows = (
        sb.table("global_market")
          .select("symbol, close, change_rate")
          .eq("date", on_date.isoformat())
          .in_("symbol", ["^IXIC", "^GSPC", "^SOX", "^VIX", "USDKRW"])
          .execute()
          .data
    ) or []
    return {r["symbol"]: r for r in rows}
