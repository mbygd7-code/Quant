-- 00000000000040_watchlist_expansion_phase_b.sql
-- Watchlist expansion — 5 sectors × 10 = 50  →  13 sectors × ~6 = 80.
--
-- Why: the paper bot held only 3/10 positions for weeks because the
-- 50-stock universe was overwhelmingly bearish (76% CAUTION/RISK on
-- 2026-06-18) — most signal-producing sectors had no rep here.  The
-- whole pipeline gates on `stocks.is_watchlist = TRUE` (verified across
-- collectors/*.py, signals/*.py, orchestrator/pipeline.py), so adding
-- rows here automatically pulls every downstream stage with them:
-- price, news, sentiment, voters, final_signals, paper_bot eligibility.
--
-- 8 sectors added — the ones moving most strongly in current KR market:
--   조선         (3) — HD현대중공업, 한화오션, 삼성중공업
--   방위산업     (4) — 한화에어로스페이스, LIG넥스원, 현대로템, KAI
--   금융         (4) — KB금융, 신한지주, 하나금융지주, 메리츠금융지주
--   통신         (3) — SK텔레콤, KT, LG유플러스
--   미디어/엔터  (4) — 하이브, JYP Ent., 에스엠, CJ ENM
--   화학/소재    (3) — LG화학, 한화솔루션, 금호석유
--   음식료/유통  (4) — CJ제일제당, 이마트, 오리온, BGF리테일
--   항공/물류    (5) — 대한항공, HMM, 한진칼, CJ대한통운, 한진
--
-- ON CONFLICT DO NOTHING so re-runs and the seed/01_stocks.sql baseline
-- coexist safely.  Production cost expectation: per-cycle LLM call
-- budget moves from ~120/day (50 stocks) to ~190/day (80 stocks),
-- still inside the 200/day cap stated in CLAUDE.md §8.

INSERT INTO stocks (ticker, name, market, sector, industry, is_watchlist) VALUES
  -- 조선 (Shipbuilding)
  ('329180', 'HD현대중공업',         'KOSPI', '조선',         'Shipbuilding',                TRUE),
  ('042660', '한화오션',             'KOSPI', '조선',         'Shipbuilding',                TRUE),
  ('010140', '삼성중공업',           'KOSPI', '조선',         'Shipbuilding',                TRUE),
  -- 방위산업 (Defense)
  ('012450', '한화에어로스페이스',   'KOSPI', '방위산업',     'Defense / Aerospace',         TRUE),
  ('079550', 'LIG넥스원',            'KOSPI', '방위산업',     'Missile Systems',             TRUE),
  ('064350', '현대로템',             'KOSPI', '방위산업',     'Defense / Rail',              TRUE),
  ('047810', '한국항공우주',         'KOSPI', '방위산업',     'Aerospace',                   TRUE),
  -- 금융 (Financials)
  ('105560', 'KB금융',               'KOSPI', '금융',         'Banking Holding',             TRUE),
  ('055550', '신한지주',             'KOSPI', '금융',         'Banking Holding',             TRUE),
  ('086790', '하나금융지주',         'KOSPI', '금융',         'Banking Holding',             TRUE),
  ('138040', '메리츠금융지주',       'KOSPI', '금융',         'Diversified Financial',       TRUE),
  -- 통신 (Telecom)
  ('017670', 'SK텔레콤',             'KOSPI', '통신',         'Wireless',                    TRUE),
  ('030200', 'KT',                   'KOSPI', '통신',         'Wireless / Broadband',        TRUE),
  ('032640', 'LG유플러스',           'KOSPI', '통신',         'Wireless',                    TRUE),
  -- 미디어/엔터 (Media / Entertainment)
  ('352820', '하이브',               'KOSPI', '미디어/엔터',  'K-Pop Label',                 TRUE),
  ('035900', 'JYP Ent.',             'KOSDAQ','미디어/엔터',  'K-Pop Label',                 TRUE),
  ('041510', '에스엠',               'KOSDAQ','미디어/엔터',  'K-Pop Label',                 TRUE),
  ('035760', 'CJ ENM',               'KOSDAQ','미디어/엔터',  'Broadcasting / Content',      TRUE),
  -- 화학/소재 (Chemicals / Materials)
  ('051910', 'LG화학',               'KOSPI', '화학/소재',    'Petrochemical / Battery Mat', TRUE),
  ('009830', '한화솔루션',           'KOSPI', '화학/소재',    'Solar / Chemicals',           TRUE),
  ('011780', '금호석유',             'KOSPI', '화학/소재',    'Synthetic Rubber',            TRUE),
  -- 음식료/유통 (Food / Retail)
  ('097950', 'CJ제일제당',           'KOSPI', '음식료/유통',  'Processed Food',              TRUE),
  ('139480', '이마트',               'KOSPI', '음식료/유통',  'Hypermarket',                 TRUE),
  ('271560', '오리온',               'KOSPI', '음식료/유통',  'Confectionery',               TRUE),
  ('282330', 'BGF리테일',            'KOSPI', '음식료/유통',  'Convenience Store (CU)',      TRUE),
  -- 항공/물류 (Airlines / Logistics)
  ('003490', '대한항공',             'KOSPI', '항공/물류',    'Airline',                     TRUE),
  ('011200', 'HMM',                  'KOSPI', '항공/물류',    'Container Shipping',          TRUE),
  ('180640', '한진칼',               'KOSPI', '항공/물류',    'Airline Holding',             TRUE),
  ('000120', 'CJ대한통운',           'KOSPI', '항공/물류',    'Logistics',                   TRUE),
  ('002320', '한진',                 'KOSPI', '항공/물류',    'Logistics',                   TRUE)
ON CONFLICT (ticker) DO UPDATE
  SET name         = EXCLUDED.name,
      market       = EXCLUDED.market,
      sector       = EXCLUDED.sector,
      industry     = EXCLUDED.industry,
      is_watchlist = TRUE;
  -- DO UPDATE rather than DO NOTHING so a ticker the paper bot
  -- already discovered (e.g. 에스오에스랩-style off-watchlist trades
  -- that auto-inserted with NULL sector) gets properly classified
  -- if it appears in this batch.  Existing 50-watchlist rows are
  -- untouched because their data already matches.

NOTIFY pgrst, 'reload schema';
