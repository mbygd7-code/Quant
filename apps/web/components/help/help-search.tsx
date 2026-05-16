'use client';

/**
 * Help-page search box. Type a term, abbreviation, or section name
 * and the matched entry jumps the page to its anchor with a brief
 * flash highlight on the target section.
 *
 * Architecture notes:
 *   • Server page stays a server component. This is the only client
 *     island, embedded inside the hero.
 *   • Search index is static + hand-curated. Each entry has:
 *       label    — what the dropdown row shows
 *       category — small grey tag on the right ('섹션', '지표', etc.)
 *       sectionId — DOM id to scrollIntoView
 *       matchText — concatenated lowercase keywords for substring
 *                   matching. Includes both Korean and English forms
 *                   so 'ma', '이동평균', 'moving average' all hit.
 *   • Keyboard: ↑/↓ navigate, Enter select, Esc dismiss.
 *   • Visual feedback after navigation: target gets `.help-flash`
 *     class (defined in globals.css) for ~1.5s to confirm landing.
 */

import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

interface Entry {
  label: string;
  category: string;
  sectionId: string;
  matchText: string;     // lowercased, concatenated keywords
}

const RAW_ENTRIES: Array<Omit<Entry, 'matchText'> & { keywords: string[] }> = [
  // ─── Section anchors ─────────────────────────────────
  { label: '기본 용어',              category: '섹션', sectionId: 'basics',
    keywords: ['기본', '용어', '시가', '종가', '고가', '저가', '거래량', '등락률', 'OHLC', 'OHLV'] },
  { label: '캔들봉 (Candlestick)',   category: '섹션', sectionId: 'candles',
    keywords: ['캔들', '캔들봉', 'candle', 'candlestick', '양봉', '음봉', '몸통', '꼬리', 'wick', 'body'] },
  { label: '차트 도구',              category: '섹션', sectionId: 'chart-tools',
    keywords: ['차트', '도구', 'MA', 'Bollinger', 'RSI', 'OBV', '이동평균'] },
  { label: '거래량 페인',            category: '섹션', sectionId: 'volume',
    keywords: ['거래량', 'volume', '평균거래량', '상대거래량', '매수매도'] },
  { label: 'AI 5단계 신호',          category: '섹션', sectionId: 'signals',
    keywords: ['신호', 'AI', '강한 관심', '관심', '관망', '주의', '위험', 'signal', '5단계'] },
  { label: '6 전문가 (Voters)',      category: '섹션', sectionId: 'voters',
    keywords: ['전문가', 'voter', '그레이엄', '다우', '터링', '시러', '케인즈', '탈레브'] },
  { label: '정확도 지표',            category: '섹션', sectionId: 'accuracy',
    keywords: ['정확도', 'MAE', 'MAPE', 'skill', '방향일치', '신뢰도'] },
  { label: '단축키 · 도구',          category: '섹션', sectionId: 'shortcuts',
    keywords: ['단축키', 'space', '드래그', 'esc', '키보드'] },
  { label: '실전 적용',              category: '섹션', sectionId: 'apply',
    keywords: ['적용', '실전', '체크리스트', '금지'] },
  { label: '용어 사전 (Glossary)',   category: '섹션', sectionId: 'glossary',
    keywords: ['용어사전', '사전', 'glossary', '약어'] },

  // ─── Basics ──────────────────────────────────────────
  { label: '시가 / 종가 (Open / Close)', category: '가격', sectionId: 'basics',
    keywords: ['시가', '종가', 'open', 'close', '개장가', 'O', 'C', 'OHLC'] },
  { label: '고가 / 저가 (High / Low)',    category: '가격', sectionId: 'basics',
    keywords: ['고가', '저가', 'high', 'low', '최고가', '최저가', 'H', 'L'] },
  { label: '거래량 (Volume)',             category: '가격', sectionId: 'basics',
    keywords: ['거래량', 'volume', 'V'] },
  { label: '등락률 (Change Rate)',        category: '가격', sectionId: 'basics',
    keywords: ['등락률', '변동률', 'change', 'rate', '상승률', '하락률'] },

  // ─── Candles ─────────────────────────────────────────
  { label: '양봉 / 음봉 (Bullish / Bearish candle)', category: '캔들', sectionId: 'candles',
    keywords: ['양봉', '음봉', 'bullish', 'bearish', '상승봉', '하락봉'] },
  { label: 'Wick (꼬리)',                category: '캔들', sectionId: 'candles',
    keywords: ['wick', 'shadow', '꼬리', '윗꼬리', '아랫꼬리'] },
  { label: 'Body (몸통)',                category: '캔들', sectionId: 'candles',
    keywords: ['body', '몸통', 'real body'] },

  // ─── Technical indicators ────────────────────────────
  { label: 'MA — Moving Average (이동평균선)', category: '지표', sectionId: 'chart-tools',
    keywords: ['MA', 'moving average', '이동평균', '이동평균선', 'MA5', 'MA20', 'MA60', 'MA120'] },
  { label: 'EMA — Exponential Moving Average', category: '지표', sectionId: 'glossary',
    keywords: ['EMA', 'exponential moving average', '지수이동평균'] },
  { label: 'BB — Bollinger Bands (볼린저 밴드)', category: '지표', sectionId: 'chart-tools',
    keywords: ['BB', 'bollinger', 'bands', '볼린저', '볼린저밴드', 'sigma', 'σ', '표준편차'] },
  { label: 'RSI — Relative Strength Index (상대강도지수)', category: '지표', sectionId: 'chart-tools',
    keywords: ['RSI', 'relative strength', '상대강도', '상대강도지수', 'wilder', '과매수', '과매도'] },
  { label: 'OBV — On-Balance Volume', category: '지표', sectionId: 'chart-tools',
    keywords: ['OBV', 'on-balance volume', '누적거래량', 'granville', '매집', '분배'] },
  { label: 'MACD — Moving Average Convergence Divergence', category: '지표', sectionId: 'glossary',
    keywords: ['MACD', 'macd', 'convergence', 'divergence'] },
  { label: 'VWAP — Volume-Weighted Average Price', category: '지표', sectionId: 'glossary',
    keywords: ['VWAP', 'volume weighted', '가중평균가'] },
  { label: 'ATR — Average True Range', category: '지표', sectionId: 'glossary',
    keywords: ['ATR', 'average true range', '평균진폭'] },
  { label: 'Golden Cross / Death Cross (골든크로스 / 데드크로스)', category: '지표', sectionId: 'chart-tools',
    keywords: ['golden cross', 'death cross', '골든크로스', '데드크로스'] },
  { label: 'Breakout / Breakdown (돌파 / 이탈)', category: '지표', sectionId: 'glossary',
    keywords: ['breakout', 'breakdown', '돌파', '이탈', '지지', '저항'] },
  { label: 'Support / Resistance (지지 / 저항)', category: '지표', sectionId: 'glossary',
    keywords: ['support', 'resistance', '지지선', '저항선'] },
  { label: 'Divergence (다이버전스)', category: '지표', sectionId: 'glossary',
    keywords: ['divergence', '다이버전스'] },
  { label: 'σ — Sigma / Standard Deviation', category: '지표', sectionId: 'glossary',
    keywords: ['sigma', 'σ', 'standard deviation', '표준편차'] },

  // ─── Financial ratios ────────────────────────────────
  { label: 'PER (P/E) — Price-to-Earnings Ratio (주가수익비율)', category: '재무', sectionId: 'glossary',
    keywords: ['PER', 'PE', 'p/e', 'price to earnings', '주가수익비율'] },
  { label: 'PBR (P/B) — Price-to-Book Ratio (주가순자산비율)', category: '재무', sectionId: 'glossary',
    keywords: ['PBR', 'PB', 'p/b', 'price to book', '주가순자산비율'] },
  { label: 'EPS — Earnings Per Share (주당순이익)', category: '재무', sectionId: 'glossary',
    keywords: ['EPS', 'earnings per share', '주당순이익'] },
  { label: 'BPS — Book-value Per Share (주당순자산)', category: '재무', sectionId: 'glossary',
    keywords: ['BPS', 'book value per share', '주당순자산'] },
  { label: 'ROE — Return on Equity (자기자본이익률)', category: '재무', sectionId: 'glossary',
    keywords: ['ROE', 'return on equity', '자기자본이익률'] },
  { label: 'ROA — Return on Assets (총자산이익률)', category: '재무', sectionId: 'glossary',
    keywords: ['ROA', 'return on assets', '총자산이익률'] },
  { label: 'DPS — Dividend Per Share (주당배당금)', category: '재무', sectionId: 'glossary',
    keywords: ['DPS', 'dividend per share', '주당배당금'] },
  { label: 'Dividend Yield (배당수익률)', category: '재무', sectionId: 'glossary',
    keywords: ['dividend yield', '배당수익률', '배당'] },
  { label: 'CAPE — Cyclically Adjusted P/E (Shiller PE)', category: '재무', sectionId: 'glossary',
    keywords: ['CAPE', 'shiller', 'cyclically adjusted'] },
  { label: 'Market Cap — 시가총액', category: '재무', sectionId: 'glossary',
    keywords: ['market cap', 'capitalization', '시가총액', '시총'] },

  // ─── AI · Stats ──────────────────────────────────────
  { label: 'MAE — Mean Absolute Error', category: 'AI/통계', sectionId: 'accuracy',
    keywords: ['MAE', 'mean absolute error', '평균오차', '평균절대오차'] },
  { label: 'MAPE — Mean Absolute Percentage Error', category: 'AI/통계', sectionId: 'accuracy',
    keywords: ['MAPE', 'mean absolute percentage', '평균비율오차'] },
  { label: 'RMSE — Root Mean Square Error', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['RMSE', 'root mean square error', '평균제곱근오차'] },
  { label: 'Direction Accuracy (방향 일치율)', category: 'AI/통계', sectionId: 'accuracy',
    keywords: ['direction', 'directional', 'accuracy', '방향일치', '방향성'] },
  { label: 'Skill Score', category: 'AI/통계', sectionId: 'accuracy',
    keywords: ['skill', 'skill score', 'naive baseline', '기상학'] },
  { label: 'Reliability — 신뢰도', category: 'AI/통계', sectionId: 'accuracy',
    keywords: ['reliability', '신뢰도', '높음', '보통', '낮음'] },
  { label: 'GBM / GBR — Gradient Boosting', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['GBM', 'GBR', 'gradient boosting', 'machine', 'regressor'] },
  { label: 'OLS — Ordinary Least Squares', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['OLS', 'ordinary least squares', '최소제곱법'] },
  { label: 'LLM — Large Language Model', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['LLM', 'large language model', '언어모델', 'GPT', 'claude'] },
  { label: 'AUC — Area Under the Curve', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['AUC', 'area under curve', 'ROC'] },
  { label: 'CI — Confidence Interval (신뢰구간)', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['CI', 'confidence interval', '신뢰구간', '95%'] },
  { label: 'Backtest (백테스트)', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['backtest', '백테스트'] },
  { label: 'Drawdown (낙폭)', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['drawdown', '낙폭', 'MDD', 'maximum drawdown'] },
  { label: 'Sharpe Ratio (샤프 비율)', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['sharpe', 'sharpe ratio', '샤프비율'] },
  { label: 'Naive Baseline', category: 'AI/통계', sectionId: 'glossary',
    keywords: ['naive', 'baseline', '순진'] },

  // ─── Market terms ────────────────────────────────────
  { label: 'KOSPI — Korea Composite Stock Price Index (코스피)', category: '시장', sectionId: 'glossary',
    keywords: ['KOSPI', '코스피', 'korea composite'] },
  { label: 'KOSDAQ (코스닥)', category: '시장', sectionId: 'glossary',
    keywords: ['KOSDAQ', '코스닥'] },
  { label: 'NASDAQ (나스닥)', category: '시장', sectionId: 'glossary',
    keywords: ['NASDAQ', '나스닥'] },
  { label: 'NYSE — New York Stock Exchange', category: '시장', sectionId: 'glossary',
    keywords: ['NYSE', 'new york stock exchange'] },
  { label: 'KRX — Korea Exchange (한국거래소)', category: '시장', sectionId: 'glossary',
    keywords: ['KRX', '한국거래소'] },
  { label: 'ETF — Exchange-Traded Fund (상장지수펀드)', category: '시장', sectionId: 'glossary',
    keywords: ['ETF', 'exchange traded fund', '상장지수펀드'] },
  { label: 'ETN — Exchange-Traded Note', category: '시장', sectionId: 'glossary',
    keywords: ['ETN', 'exchange traded note', '상장지수증권'] },
  { label: 'IPO — Initial Public Offering (기업공개)', category: '시장', sectionId: 'glossary',
    keywords: ['IPO', '기업공개', 'initial public offering'] },
  { label: 'Bull / Bear Market (강세장 / 약세장)', category: '시장', sectionId: 'glossary',
    keywords: ['bull', 'bear', '강세장', '약세장'] },
  { label: 'Bid / Ask (매수호가 / 매도호가)', category: '시장', sectionId: 'glossary',
    keywords: ['bid', 'ask', '매수호가', '매도호가', '호가'] },
  { label: '상한가 / 하한가 (Daily Price Limit)', category: '시장', sectionId: 'glossary',
    keywords: ['상한가', '하한가', 'price limit', '30%'] },
  { label: '대장주 (Leader Stock)', category: '시장', sectionId: 'glossary',
    keywords: ['대장주', 'leader'] },
  { label: '대형주 / 중형주 / 소형주 (Large/Mid/Small Cap)', category: '시장', sectionId: 'glossary',
    keywords: ['대형주', '중형주', '소형주', 'large cap', 'mid cap', 'small cap'] },
  { label: '추세 / 모멘텀 (Trend / Momentum)', category: '시장', sectionId: 'glossary',
    keywords: ['추세', '모멘텀', 'trend', 'momentum'] },
  { label: '변동성 (Volatility)', category: '시장', sectionId: 'glossary',
    keywords: ['변동성', 'volatility'] },
  { label: '유동성 (Liquidity)', category: '시장', sectionId: 'glossary',
    keywords: ['유동성', 'liquidity', '슬리피지', 'slippage'] },
  { label: '횡보 (Sideways / Consolidation)', category: '시장', sectionId: 'glossary',
    keywords: ['횡보', 'sideways', 'consolidation', '박스권'] },

  // ─── Service-specific ────────────────────────────────
  { label: '5단계 신호 — 강한 관심 · 관심 · 관망 · 주의 · 위험', category: '서비스', sectionId: 'signals',
    keywords: ['5단계', '강한관심', '관심', '관망', '주의', '위험', '신호'] },
  { label: '6 Voters — 그레이엄·다우·터링·시러·케인즈·탈레브', category: '서비스', sectionId: 'voters',
    keywords: ['voter', 'voters', '그레이엄', 'graham', '다우', 'dow', '터링', 'turing',
              '시러', 'shiller', '케인즈', 'keynes', '탈레브', 'taleb'] },
  { label: 'Watchlist (관심주식)', category: '서비스', sectionId: 'glossary',
    keywords: ['watchlist', '관심주식', '50종목'] },
  { label: 'Master 종목 (마스터 등록)', category: '서비스', sectionId: 'glossary',
    keywords: ['master', '마스터', '등록'] },
  { label: 'RAG — Retrieval-Augmented Generation', category: '서비스', sectionId: 'glossary',
    keywords: ['RAG', 'retrieval', 'augmented', 'generation'] },
  { label: '청크 (Knowledge Chunk)', category: '서비스', sectionId: 'glossary',
    keywords: ['청크', 'chunk', '지식'] },

  // ─── Shortcuts ───────────────────────────────────────
  { label: 'Space — 호버 창 확장', category: '단축키', sectionId: 'shortcuts',
    keywords: ['space', '스페이스', '호버', '확장'] },
  { label: '클릭+드래그 — 구간 측정', category: '단축키', sectionId: 'shortcuts',
    keywords: ['드래그', 'drag', '측정', '구간', 'measure'] },
  { label: 'Esc — 측정 해제', category: '단축키', sectionId: 'shortcuts',
    keywords: ['esc', 'escape', '해제'] },
  { label: 'S/M/L/XL — 거래량 페인 크기', category: '단축키', sectionId: 'shortcuts',
    keywords: ['S', 'M', 'L', 'XL', '거래량페인', '크기'] },
];

const ENTRIES: Entry[] = RAW_ENTRIES.map((e) => ({
  label: e.label,
  category: e.category,
  sectionId: e.sectionId,
  matchText: [...e.keywords, e.label, e.category]
    .join(' ')
    .toLowerCase(),
}));

export function HelpSearch() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    return ENTRIES.filter((e) => e.matchText.includes(q)).slice(0, 12);
  }, [query]);

  // Reset highlight when filter changes.
  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const goTo = (entry: Entry) => {
    const el = document.getElementById(entry.sectionId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Add a brief flash class to highlight where the user landed.
      el.classList.add('help-flash');
      window.setTimeout(() => el.classList.remove('help-flash'), 1600);
    }
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="relative mt-5">
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-5 w-5 text-txt-muted pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => Math.min(filtered.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (filtered[highlight]) goTo(filtered[highlight]);
            } else if (e.key === 'Escape') {
              setOpen(false);
              setQuery('');
              inputRef.current?.blur();
            }
          }}
          placeholder="용어 / 약자 / 섹션 검색 (예: MA, RSI, PER, 거래량, 골든크로스)"
          className="w-full pl-11 pr-10 py-3.5 text-[15px] rounded-xl border-2 border-border-default bg-bg-secondary text-txt-primary placeholder:text-txt-muted focus:border-brand-purple/60 focus:outline-none focus:ring-4 focus:ring-brand-purple/15 transition-all shadow-sm"
          aria-label="도움말 검색"
          aria-expanded={open && filtered.length > 0}
          aria-controls="help-search-results"
          autoComplete="off"
        />
        {query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 hover:bg-bg-tertiary transition-colors"
            aria-label="검색어 지우기"
          >
            <X className="h-4 w-4 text-txt-muted" />
          </button>
        )}
      </div>

      {/* Results dropdown */}
      {open && filtered.length > 0 && (
        <ul
          id="help-search-results"
          role="listbox"
          className="absolute z-30 mt-2 w-full rounded-xl border-2 border-border-default bg-bg-secondary shadow-2xl overflow-hidden max-h-[380px] overflow-y-auto"
        >
          {filtered.map((entry, i) => (
            <li
              key={`${entry.sectionId}-${entry.label}`}
              role="option"
              aria-selected={highlight === i}
              onClick={() => goTo(entry)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'flex items-center justify-between gap-3 px-4 py-3 cursor-pointer border-b border-border-subtle/40 last:border-b-0 transition-colors',
                highlight === i
                  ? 'bg-brand-purple/10'
                  : 'hover:bg-bg-tertiary/40',
              )}
            >
              <span className="text-[14px] font-medium text-txt-primary truncate">
                {entry.label}
              </span>
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wider text-brand-purple/80 bg-brand-purple/10 px-2 py-0.5 rounded">
                {entry.category}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Empty-state hint when typed but no matches */}
      {open && query.trim().length > 0 && filtered.length === 0 && (
        <div className="absolute z-30 mt-2 w-full rounded-xl border-2 border-border-default bg-bg-secondary shadow-2xl px-4 py-5 text-center">
          <div className="text-[14px] text-txt-secondary">
            '<span className="font-mono font-semibold text-txt-primary">{query}</span>'에 해당하는 항목 없음
          </div>
          <div className="text-[12px] text-txt-muted mt-1">
            다른 약자나 한글 키워드로 시도해보세요
          </div>
        </div>
      )}

      {/* Keyboard hint when idle */}
      {!query && (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-txt-muted">
          <kbd className="px-1.5 py-0.5 rounded border border-border-subtle/60 bg-bg-tertiary/40 font-mono font-bold text-[10px] text-txt-secondary">
            ↑↓
          </kbd>
          <span>이동</span>
          <kbd className="px-1.5 py-0.5 rounded border border-border-subtle/60 bg-bg-tertiary/40 font-mono font-bold text-[10px] text-txt-secondary">
            Enter
          </kbd>
          <span>선택</span>
          <kbd className="px-1.5 py-0.5 rounded border border-border-subtle/60 bg-bg-tertiary/40 font-mono font-bold text-[10px] text-txt-secondary">
            Esc
          </kbd>
          <span>닫기</span>
        </div>
      )}
    </div>
  );
}
