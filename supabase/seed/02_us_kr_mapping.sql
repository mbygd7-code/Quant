-- 02_us_kr_mapping.sql
-- US-KR 매핑 매트릭스 — SKILL.md 4번 그대로.
-- 알파의 핵심. impact_strength 변경은 audit_logs에 기록 (Phase 8 admin 페이지).

INSERT INTO us_kr_mapping (us_symbol, kr_ticker, relation_type, impact_strength, rationale) VALUES
  -- ─── 4-1. 반도체 ───────────────────────────────────────
  ('NVDA',   '000660', 'supply_chain',   0.92, 'HBM 공급 핵심 — 데이터센터 GPU 수요 직결'),
  ('NVDA',   '042700', 'supply_chain',   0.85, '후공정 장비 (HBM Bonder) 점유율 높음'),
  ('NVDA',   '005930', 'competitor',     0.75, 'HBM 경쟁 + 메모리 사이클 영향'),
  ('NVDA',   '058470', 'supply_chain',   0.70, '테스트 소켓 — AI 반도체 검사 수요'),
  ('NVDA',   '039030', 'supply_chain',   0.65, '레이저 어닐링 장비 — 첨단 메모리 공정'),
  ('NVDA',   '007660', 'supply_chain',   0.85, 'AI 서버 다층 PCB 핵심 공급'),
  ('NVDA',   '093320', 'sector_proxy',   0.65, 'AI/클라우드 IDC 수요 동행'),
  ('AMD',    '000660', 'supply_chain',   0.80, 'AMD MI 시리즈에 HBM 공급'),
  ('AMD',    '005930', 'supply_chain',   0.75, 'HBM/일반 메모리 공급'),
  ('MU',     '000660', 'competitor',     0.90, '메모리 직접 경쟁 (DRAM/NAND)'),
  ('MU',     '005930', 'competitor',     0.85, '메모리 직접 경쟁'),
  ('TSM',    '042700', 'supply_chain',   0.72, 'TSMC 후공정 수요 → 한미 장비'),
  ('TSM',    '005930', 'competitor',     0.55, '파운드리 경쟁 (선단 공정)'),
  ('ASML',   '240810', 'supply_chain',   0.70, 'EUV 도입 확산 → 국내 장비 주변 수요'),
  ('ASML',   '005290', 'supply_chain',   0.65, '반도체 소재 수요 연동'),
  ('ASML',   '357780', 'supply_chain',   0.65, '반도체 소재 (식각액 등)'),

  -- ─── 4-2. 2차전지 ─────────────────────────────────────
  ('TSLA',   '373220', 'supply_chain',   0.88, '4680 셀 공급 + EV 수요 직결'),
  ('TSLA',   '006400', 'supply_chain',   0.82, '각형 셀 공급'),
  ('TSLA',   '247540', 'supply_chain',   0.80, '양극재 (NCA/하이니켈)'),
  ('TSLA',   '086520', 'supply_chain',   0.75, '양극재 지주사'),
  ('TSLA',   '003670', 'supply_chain',   0.78, '양극재 (포스코홀딩스 산하)'),
  ('TSLA',   '066970', 'supply_chain',   0.75, '양극재'),
  ('RIVN',   '373220', 'supply_chain',   0.55, '셀 공급 (소량)'),
  ('LIT',    '278280', 'sector_proxy',   0.70, '리튬/2차전지 ETF 동조'),
  ('LIT',    '005070', 'sector_proxy',   0.68, '양극재 전구체'),
  ('LIT',    '393890', 'sector_proxy',   0.55, '분리막'),

  -- ─── 4-3. 자동차 ──────────────────────────────────────
  ('TSLA',   '005380', 'competitor',     0.55, '글로벌 EV 경쟁 + 점유율 영향'),
  ('TSLA',   '000270', 'competitor',     0.55, '글로벌 EV 경쟁'),
  ('F',      '005380', 'competitor',     0.50, '글로벌 자동차 수요 동행'),
  ('GM',     '005380', 'competitor',     0.50, '글로벌 자동차 수요 동행'),
  ('USDKRW', '005380', 'fx_export',      0.85, '환율 강세 → 수출 수혜'),
  ('USDKRW', '000270', 'fx_export',      0.85, '환율 강세 → 수출 수혜'),
  ('USDKRW', '012330', 'fx_export',      0.70, '수출 부품 환율 노출'),
  ('MGA',    '204320', 'competitor',     0.60, '글로벌 부품사 동조'),
  ('APTV',   '018880', 'competitor',     0.55, '글로벌 부품사 동조'),

  -- ─── 4-4. 바이오/헬스 ─────────────────────────────────
  ('LLY',    '196170', 'supply_chain',   0.65, 'GLP-1 / 바이오 라이선스'),
  ('NVO',    '196170', 'supply_chain',   0.70, '비만치료제 라이선스 모멘텀'),
  ('MRK',    '207940', 'supply_chain',   0.60, 'CMO 수주 가능성'),
  ('PFE',    '207940', 'supply_chain',   0.60, 'CMO 수주 가능성'),
  ('BIIB',   '068270', 'competitor',     0.65, '바이오시밀러/오리지널 경쟁'),
  ('XBI',    '028300', 'sector_proxy',   0.55, '미국 바이오 섹터 동조'),
  ('XBI',    '141080', 'sector_proxy',   0.55, 'ADC 바이오 섹터 동조'),

  -- ─── 4-5. 인터넷/AI ───────────────────────────────────
  ('GOOGL',  '035420', 'competitor',     0.55, '검색·광고 시장 영향'),
  ('META',   '035420', 'competitor',     0.50, '광고 시장 동조'),
  ('MSFT',   '035420', 'sector_proxy',   0.55, '클라우드·AI 수요 동조'),
  ('MSFT',   '035720', 'sector_proxy',   0.50, '클라우드·AI 수요 동조'),
  ('XLK',    '012510', 'sector_proxy',   0.50, '미국 테크/SaaS 동조')
ON CONFLICT (us_symbol, kr_ticker) DO UPDATE
SET relation_type   = EXCLUDED.relation_type,
    impact_strength = EXCLUDED.impact_strength,
    rationale       = EXCLUDED.rationale,
    updated_at      = NOW();
