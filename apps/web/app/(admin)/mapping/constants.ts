export const RELATION_TYPES = [
  'supply_chain',
  'competitor',
  'sector_proxy',
  'fx_export',
  'customer',
  'supplier',
  'leading_indicator',
] as const;

export type RelationType = typeof RELATION_TYPES[number];

export const RELATION_LABELS: Record<RelationType, string> = {
  supply_chain: '공급망',
  competitor: '경쟁사',
  sector_proxy: '섹터 대리',
  fx_export: '환율/수출',
  customer: '고객사',
  supplier: '협력사',
  leading_indicator: '선행 지표',
};
