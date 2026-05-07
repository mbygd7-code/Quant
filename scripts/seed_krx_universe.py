"""Seed the `stocks` master table with a curated KOSPI/KOSDAQ universe.

This expands the discovery surface for the admin watchlist dialog so the
인기/급등/AI 추천 tabs can surface unadded candidates. It only writes
`is_watchlist=false` rows; existing watchlisted tickers are preserved.

We use a curated list (not the full ~2,500 KRX universe) because:
  - pykrx KRX scraping is unstable in CI (per CLAUDE.md §F)
  - users only need to discover *meaningful* names, not penny stocks
  - the list covers the ~150 most-traded names across major sectors

Usage:
  python -m scripts.seed_krx_universe
"""
from __future__ import annotations

from db.supabase_client import get_admin_client

# (ticker, name, market, sector) — curated, ~140 names beyond our 50.
# Sectors map to the 5 we already use plus a few new ones.
CURATED: list[tuple[str, str, str, str]] = [
    # KOSPI — 반도체 / 디스플레이
    ("009150", "삼성전기",     "KOSPI",  "반도체"),
    ("000990", "DB하이텍",     "KOSPI",  "반도체"),
    ("034220", "LG디스플레이", "KOSPI",  "디스플레이"),
    ("011070", "LG이노텍",     "KOSPI",  "반도체"),
    ("003550", "LG",           "KOSPI",  "지주사"),
    # KOSPI — 금융
    ("055550", "신한지주",     "KOSPI",  "금융"),
    ("105560", "KB금융",       "KOSPI",  "금융"),
    ("086790", "하나금융지주", "KOSPI",  "금융"),
    ("316140", "우리금융지주", "KOSPI",  "금융"),
    ("024110", "기업은행",     "KOSPI",  "금융"),
    ("138930", "BNK금융지주",  "KOSPI",  "금융"),
    ("139130", "DGB금융지주",  "KOSPI",  "금융"),
    ("071050", "한국금융지주", "KOSPI",  "금융"),
    ("030200", "KT",           "KOSPI",  "통신"),
    ("017670", "SK텔레콤",     "KOSPI",  "통신"),
    ("032640", "LG유플러스",   "KOSPI",  "통신"),
    # KOSPI — 화학/소재
    ("051910", "LG화학",       "KOSPI",  "화학"),
    ("011170", "롯데케미칼",   "KOSPI",  "화학"),
    ("005490", "POSCO홀딩스",  "KOSPI",  "철강"),
    ("004020", "현대제철",     "KOSPI",  "철강"),
    ("010130", "고려아연",     "KOSPI",  "비철금속"),
    ("009830", "한화솔루션",   "KOSPI",  "화학"),
    ("298050", "효성첨단소재", "KOSPI",  "화학"),
    ("298040", "효성중공업",   "KOSPI",  "기계"),
    # KOSPI — 운송/조선
    ("009540", "HD한국조선해양","KOSPI", "조선"),
    ("042660", "한화오션",     "KOSPI",  "조선"),
    ("010140", "삼성중공업",   "KOSPI",  "조선"),
    ("180640", "한진칼",       "KOSPI",  "운송"),
    ("003490", "대한항공",     "KOSPI",  "운송"),
    ("011200", "HMM",          "KOSPI",  "해운"),
    # KOSPI — 소비재/유통
    ("097950", "CJ제일제당",   "KOSPI",  "음식료"),
    ("271560", "오리온",       "KOSPI",  "음식료"),
    ("004990", "롯데지주",     "KOSPI",  "지주사"),
    ("023530", "롯데쇼핑",     "KOSPI",  "유통"),
    ("139480", "이마트",       "KOSPI",  "유통"),
    ("282330", "BGF리테일",    "KOSPI",  "유통"),
    ("007310", "오뚜기",       "KOSPI",  "음식료"),
    ("006400", "CJ대한통운",   "KOSPI",  "물류"),
    # KOSPI — 엔터/콘텐츠
    ("251270", "넷마블",       "KOSPI",  "게임"),
    ("352820", "하이브",       "KOSPI",  "엔터"),
    ("041510", "에스엠",       "KOSDAQ", "엔터"),
    ("122870", "와이지엔터테인먼트","KOSDAQ","엔터"),
    ("035900", "JYP Ent.",     "KOSDAQ", "엔터"),
    # KOSPI — 건설/유틸리티
    ("000720", "현대건설",     "KOSPI",  "건설"),
    ("028050", "삼성E&A",      "KOSPI",  "건설"),
    ("047040", "대우건설",     "KOSPI",  "건설"),
    ("015760", "한국전력",     "KOSPI",  "유틸리티"),
    ("036460", "한국가스공사", "KOSPI",  "유틸리티"),
    # KOSPI — 보험
    ("088350", "한화생명",     "KOSPI",  "보험"),
    ("000810", "삼성화재",     "KOSPI",  "보험"),
    ("032830", "삼성생명",     "KOSPI",  "보험"),
    ("005830", "DB손해보험",   "KOSPI",  "보험"),
    # KOSPI — 자동차/부품 (보조)
    ("011210", "현대위아",     "KOSPI",  "자동차"),
    ("018880", "한온시스템",   "KOSPI",  "자동차"),
    # KOSDAQ — 반도체/IT 부품
    ("095340", "ISC",          "KOSDAQ", "반도체"),
    ("403870", "HPSP",         "KOSDAQ", "반도체"),
    ("131970", "테스나",       "KOSDAQ", "반도체"),
    ("418550", "제이오",       "KOSDAQ", "2차전지"),
    ("357780", "솔브레인",     "KOSDAQ", "반도체"),
    ("214450", "파마리서치",   "KOSDAQ", "바이오"),
    ("950140", "잉글우드랩",   "KOSDAQ", "화장품"),
    ("145020", "휴젤",         "KOSDAQ", "바이오"),
    ("214150", "클래시스",     "KOSDAQ", "헬스케어"),
    ("085660", "차바이오텍",   "KOSDAQ", "바이오"),
    ("196170", "알테오젠",     "KOSDAQ", "바이오"),
    ("328130", "루닛",         "KOSDAQ", "바이오"),
    ("277810", "레인보우로보틱스","KOSDAQ","로봇"),
    ("064350", "현대로템",     "KOSPI",  "기계"),
    # KOSDAQ — 게임/IT 서비스
    ("293490", "카카오게임즈", "KOSDAQ", "게임"),
    ("194480", "데브시스터즈", "KOSDAQ", "게임"),
    ("112040", "위메이드",     "KOSDAQ", "게임"),
    ("181710", "NHN",          "KOSPI",  "인터넷/AI"),
    ("035600", "KG이니시스",   "KOSDAQ", "결제"),
    ("377300", "카카오페이",   "KOSPI",  "결제"),
    ("418550", "PI첨단소재",   "KOSPI",  "화학"),
    # KOSDAQ — 미디어
    ("079160", "CJ CGV",       "KOSPI",  "미디어"),
    ("130960", "CJ ENM",       "KOSDAQ", "미디어"),
    ("034230", "파라다이스",   "KOSDAQ", "엔터"),
    ("114090", "GKL",          "KOSPI",  "엔터"),
    # KOSDAQ — 반도체 장비
    ("140860", "파크시스템스", "KOSDAQ", "반도체"),
    ("237690", "에스티팜",     "KOSDAQ", "바이오"),
    ("085370", "루트로닉",     "KOSDAQ", "헬스케어"),
    ("122990", "와이솔",       "KOSDAQ", "전자부품"),
    ("099190", "아이센스",     "KOSDAQ", "헬스케어"),
    ("226320", "잇츠한불",     "KOSDAQ", "화장품"),
    ("101490", "에스앤에스텍", "KOSDAQ", "반도체"),
    ("204270", "제이앤티씨",   "KOSDAQ", "전자부품"),
    ("265520", "AP시스템",     "KOSDAQ", "디스플레이"),
    ("215000", "골프존",       "KOSDAQ", "여가"),
    # KOSDAQ — 2차전지 (보조)
    ("145720", "더블유게임즈", "KOSDAQ", "게임"),
    ("388790", "케이엔에스",   "KOSDAQ", "2차전지"),
    ("363280", "티와이홀딩스", "KOSPI",  "지주사"),
    # 추가 KOSPI 대형주
    ("003410", "쌍용C&E",      "KOSPI",  "건설"),
    ("064960", "S&T모티브",    "KOSPI",  "자동차"),
    ("005940", "NH투자증권",   "KOSPI",  "금융"),
    ("016360", "삼성증권",     "KOSPI",  "금융"),
    ("006800", "미래에셋증권", "KOSPI",  "금융"),
    ("078930", "GS",           "KOSPI",  "지주사"),
    ("004800", "효성",         "KOSPI",  "지주사"),
    ("066570", "LG전자",       "KOSPI",  "가전"),
    ("268280", "미원에스씨",   "KOSDAQ", "화학"),
    ("024720", "한국콜마홀딩스","KOSPI", "화장품"),
    ("161890", "한국콜마",     "KOSPI",  "화장품"),
    ("090430", "아모레퍼시픽", "KOSPI",  "화장품"),
    ("002790", "아모레G",      "KOSPI",  "화장품"),
    ("034730", "SK",           "KOSPI",  "지주사"),
    ("128940", "한미약품",     "KOSPI",  "바이오/헬스"),
    ("000100", "유한양행",     "KOSPI",  "바이오/헬스"),
    ("009240", "한샘",         "KOSPI",  "가구"),
    ("093050", "LF",           "KOSPI",  "패션"),
    ("020150", "롯데에너지머티리얼즈","KOSPI","2차전지"),
]


def fetch_universe(limit: int | None) -> list[dict]:
    rows = [
        {"ticker": t, "name": n, "market": m, "sector": s}
        for t, n, m, s in CURATED
    ]
    if limit:
        return rows[:limit]
    return rows


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    sb = get_admin_client()

    print("[seed-krx] preparing curated KR universe...")
    universe_raw = fetch_universe(args.limit)
    # Dedupe by ticker (curated list may collide on re-used codes)
    seen: set[str] = set()
    universe: list[dict] = []
    for r in universe_raw:
        if r["ticker"] in seen:
            continue
        seen.add(r["ticker"])
        universe.append(r)
    print(f"[seed-krx] {len(universe)} unique tickers")

    # Skip tickers that already exist (preserve is_watchlist + sector data)
    existing = (
        sb.table("stocks").select("ticker").execute().data
    ) or []
    existing_set = {r["ticker"] for r in existing}
    new_rows = [
        {**r, "is_watchlist": False}
        for r in universe
        if r["ticker"] not in existing_set
    ]
    print(f"[seed-krx] {len(new_rows)} new tickers to insert "
          f"(skipped {len(universe) - len(new_rows)} existing)")

    # Insert in chunks (Supabase REST limit ~1000)
    CHUNK = 500
    inserted = 0
    for i in range(0, len(new_rows), CHUNK):
        chunk = new_rows[i:i + CHUNK]
        sb.table("stocks").insert(chunk).execute()
        inserted += len(chunk)
        print(f"[seed-krx] inserted {inserted} / {len(new_rows)}")

    print("[seed-krx] done")


if __name__ == "__main__":
    main()
