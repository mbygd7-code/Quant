-- 01_stocks.sql
-- 한국 50종목 (CLAUDE.md 2-1) + 매핑용 미국 종목.
-- ON CONFLICT 로 멱등성 보장 — 여러 번 실행해도 안전.

-- ═══════════════════════════════════════════════════════════
-- 한국 50종목 (관심종목)
-- ═══════════════════════════════════════════════════════════
INSERT INTO stocks (ticker, name, market, sector, industry, is_watchlist) VALUES
  -- 반도체
  ('005930', '삼성전자',         'KOSPI',  '반도체',     'Memory/Foundry',        TRUE),
  ('000660', 'SK하이닉스',       'KOSPI',  '반도체',     'Memory (HBM)',          TRUE),
  ('042700', '한미반도체',       'KOSPI',  '반도체',     'Backend Equipment',     TRUE),
  ('058470', '리노공업',         'KOSDAQ', '반도체',     'Test Sockets',          TRUE),
  ('005290', '동진쎄미켐',       'KOSDAQ', '반도체',     'Materials',             TRUE),
  ('240810', '원익IPS',          'KOSDAQ', '반도체',     'Equipment',             TRUE),
  ('039030', '이오테크닉스',     'KOSDAQ', '반도체',     'Laser Equipment',       TRUE),
  ('357780', '솔브레인',         'KOSDAQ', '반도체',     'Materials',             TRUE),
  ('067310', '하나마이크론',     'KOSDAQ', '반도체',     'OSAT',                  TRUE),
  ('000990', 'DB하이텍',         'KOSPI',  '반도체',     'Foundry',               TRUE),
  -- 2차전지
  ('373220', 'LG에너지솔루션',   'KOSPI',  '2차전지',    'Cell Manufacturing',    TRUE),
  ('006400', '삼성SDI',          'KOSPI',  '2차전지',    'Cell Manufacturing',    TRUE),
  ('003670', '포스코퓨처엠',     'KOSPI',  '2차전지',    'Cathode Material',      TRUE),
  ('247540', '에코프로비엠',     'KOSDAQ', '2차전지',    'Cathode Material',      TRUE),
  ('086520', '에코프로',         'KOSDAQ', '2차전지',    'Holding Company',       TRUE),
  ('066970', '엘앤에프',         'KOSDAQ', '2차전지',    'Cathode Material',      TRUE),
  ('096770', 'SK이노베이션',     'KOSPI',  '2차전지',    'Cell + Energy',         TRUE),
  ('005070', '코스모신소재',     'KOSPI',  '2차전지',    'Cathode Precursor',     TRUE),
  ('278280', '천보',             'KOSDAQ', '2차전지',    'Electrolyte Additive',  TRUE),
  ('393890', '더블유씨피',       'KOSDAQ', '2차전지',    'Separator',             TRUE),
  -- 자동차
  ('005380', '현대차',           'KOSPI',  '자동차',     'OEM',                   TRUE),
  ('000270', '기아',             'KOSPI',  '자동차',     'OEM',                   TRUE),
  ('012330', '현대모비스',       'KOSPI',  '자동차',     'Tier-1 Parts',          TRUE),
  ('204320', 'HL만도',           'KOSPI',  '자동차',     'Brake/Steering',        TRUE),
  ('018880', '한온시스템',       'KOSPI',  '자동차',     'Thermal Management',    TRUE),
  ('011210', '현대위아',         'KOSPI',  '자동차',     'Powertrain',            TRUE),
  ('005850', '에스엘',           'KOSPI',  '자동차',     'Lighting',              TRUE),
  ('010690', '화신',             'KOSPI',  '자동차',     'Chassis',               TRUE),
  ('015750', '성우하이텍',       'KOSPI',  '자동차',     'Body Parts',            TRUE),
  ('043370', '평화정공',         'KOSPI',  '자동차',     'Door/Hood Hinges',      TRUE),
  -- 바이오/헬스
  ('207940', '삼성바이오로직스', 'KOSPI',  '바이오/헬스','CMO',                   TRUE),
  ('068270', '셀트리온',         'KOSPI',  '바이오/헬스','Biosimilar',            TRUE),
  ('000100', '유한양행',         'KOSPI',  '바이오/헬스','Pharma',                TRUE),
  ('326030', 'SK바이오팜',       'KOSPI',  '바이오/헬스','CNS Drug',              TRUE),
  ('028300', 'HLB',              'KOSDAQ', '바이오/헬스','Oncology',              TRUE),
  ('196170', '알테오젠',         'KOSDAQ', '바이오/헬스','Bio License',           TRUE),
  ('141080', '리가켐바이오',     'KOSDAQ', '바이오/헬스','ADC',                   TRUE),
  ('128940', '한미약품',         'KOSPI',  '바이오/헬스','Pharma',                TRUE),
  ('006280', '녹십자',           'KOSPI',  '바이오/헬스','Vaccine/Plasma',        TRUE),
  ('185750', '종근당',           'KOSPI',  '바이오/헬스','Pharma',                TRUE),
  -- 인터넷/AI
  ('035420', 'NAVER',            'KOSPI',  '인터넷/AI', 'Search/Cloud',          TRUE),
  ('035720', '카카오',           'KOSPI',  '인터넷/AI', 'Messenger/Cloud',       TRUE),
  ('259960', '크래프톤',         'KOSPI',  '인터넷/AI', 'Game',                  TRUE),
  ('036570', '엔씨소프트',       'KOSPI',  '인터넷/AI', 'Game',                  TRUE),
  ('263750', '펄어비스',         'KOSDAQ', '인터넷/AI', 'Game',                  TRUE),
  ('012510', '더존비즈온',       'KOSPI',  '인터넷/AI', 'SaaS',                  TRUE),
  ('042000', '카페24',           'KOSDAQ', '인터넷/AI', 'eCommerce SaaS',        TRUE),
  ('053800', '안랩',             'KOSDAQ', '인터넷/AI', 'Security',              TRUE),
  ('007660', '이수페타시스',     'KOSPI',  '인터넷/AI', 'AI Server PCB',         TRUE),
  ('093320', '케이아이엔엑스',   'KOSDAQ', '인터넷/AI', 'IDC',                   TRUE)
ON CONFLICT (ticker) DO UPDATE
SET name         = EXCLUDED.name,
    market       = EXCLUDED.market,
    sector       = EXCLUDED.sector,
    industry     = EXCLUDED.industry,
    is_watchlist = EXCLUDED.is_watchlist;

-- ═══════════════════════════════════════════════════════════
-- 매핑에 등장하는 미국 종목 / 지수 / FX (관심종목 아님)
-- ═══════════════════════════════════════════════════════════
INSERT INTO stocks (ticker, name, market, sector, industry, is_watchlist) VALUES
  -- US 종목
  ('NVDA',  'Nvidia',                'NASDAQ', '반도체',         'GPU/AI',                   FALSE),
  ('AMD',   'AMD',                   'NASDAQ', '반도체',         'CPU/GPU',                  FALSE),
  ('MU',    'Micron Technology',     'NASDAQ', '반도체',         'Memory',                   FALSE),
  ('TSM',   'TSMC',                  'NYSE',   '반도체',         'Foundry',                  FALSE),
  ('ASML',  'ASML Holding',          'NASDAQ', '반도체',         'Lithography',              FALSE),
  ('TSLA',  'Tesla',                 'NASDAQ', '자동차/2차전지', 'EV',                       FALSE),
  ('RIVN',  'Rivian',                'NASDAQ', '자동차',         'EV',                       FALSE),
  ('F',     'Ford',                  'NYSE',   '자동차',         'OEM',                      FALSE),
  ('GM',    'General Motors',        'NYSE',   '자동차',         'OEM',                      FALSE),
  ('AAPL',  'Apple',                 'NASDAQ', '인터넷/AI',      'Consumer Tech',            FALSE),
  ('MSFT',  'Microsoft',             'NASDAQ', '인터넷/AI',      'Cloud/AI',                 FALSE),
  ('GOOGL', 'Alphabet',              'NASDAQ', '인터넷/AI',      'Search/Cloud',             FALSE),
  ('META',  'Meta Platforms',        'NASDAQ', '인터넷/AI',      'Social/Ads',               FALSE),
  ('LLY',   'Eli Lilly',             'NYSE',   '바이오/헬스',    'Pharma (GLP-1)',           FALSE),
  ('MRK',   'Merck',                 'NYSE',   '바이오/헬스',    'Pharma',                   FALSE),
  ('PFE',   'Pfizer',                'NYSE',   '바이오/헬스',    'Pharma',                   FALSE),
  ('NVO',   'Novo Nordisk',          'NYSE',   '바이오/헬스',    'Pharma (GLP-1)',           FALSE),
  ('BIIB',  'Biogen',                'NASDAQ', '바이오/헬스',    'Pharma',                   FALSE),
  ('MGA',   'Magna International',   'NYSE',   '자동차',         'Tier-1 Parts',             FALSE),
  ('APTV',  'Aptiv',                 'NYSE',   '자동차',         'Electrical Architecture',  FALSE),
  -- 지수 / FX / ETF (market 컬럼에 자산군 표기, sector NULL)
  ('^IXIC',  'Nasdaq Composite',           'INDEX', NULL, NULL, FALSE),
  ('^GSPC',  'S&P 500',                    'INDEX', NULL, NULL, FALSE),
  ('^SOX',   'Philadelphia Semi Index',    'INDEX', NULL, NULL, FALSE),
  ('^DJI',   'Dow Jones',                  'INDEX', NULL, NULL, FALSE),
  ('^RUT',   'Russell 2000',               'INDEX', NULL, NULL, FALSE),
  ('^VIX',   'VIX',                        'INDEX', NULL, NULL, FALSE),
  ('USDKRW', 'USD/KRW',                    'FX',    NULL, NULL, FALSE),
  ('DXY',    'Dollar Index',               'FX',    NULL, NULL, FALSE),
  ('SOXX',   'iShares Semiconductor ETF',  'ETF',   NULL, NULL, FALSE),
  ('XBI',    'SPDR S&P Biotech ETF',       'ETF',   NULL, NULL, FALSE),
  ('LIT',    'Global X Lithium ETF',       'ETF',   NULL, NULL, FALSE),
  ('XLK',    'Technology Select ETF',      'ETF',   NULL, NULL, FALSE)
ON CONFLICT (ticker) DO NOTHING;
