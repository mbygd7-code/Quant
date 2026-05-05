import { getQueryClient } from '@/lib/supabase/query-client';
import { MappingTable } from '@/components/admin/mapping-table';
import { AddMappingDialog } from '@/components/admin/add-mapping-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Plus } from 'lucide-react';

export const dynamic = 'force-dynamic';

interface Row {
  id: number;
  us_symbol: string;
  kr_ticker: string;
  relation_type: string | null;
  impact_strength: number;
  rationale: string | null;
  updated_at: string;
  kr_name: string | null;
  kr_sector: string | null;
}

export default async function MappingPage() {
  const sb = await getQueryClient();

  const { data: mappings } = await sb
    .from('us_kr_mapping')
    .select('id, us_symbol, kr_ticker, relation_type, impact_strength, rationale, updated_at, stocks!us_kr_mapping_kr_ticker_fk(name, sector)')
    .order('us_symbol', { ascending: true })
    .order('impact_strength', { ascending: false });

  const rows: Row[] = ((mappings ?? []) as unknown as Array<{
    id: number;
    us_symbol: string;
    kr_ticker: string;
    relation_type: string | null;
    impact_strength: number;
    rationale: string | null;
    updated_at: string;
    stocks: { name: string | null; sector: string | null } | null;
  }>).map((r) => ({
    id: r.id,
    us_symbol: r.us_symbol,
    kr_ticker: r.kr_ticker,
    relation_type: r.relation_type,
    impact_strength: r.impact_strength,
    rationale: r.rationale,
    updated_at: r.updated_at,
    kr_name: r.stocks?.name ?? null,
    kr_sector: r.stocks?.sector ?? null,
  }));

  return (
    <div className="space-y-5 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">US-KR 매핑</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            {rows.length}개 매핑 — 셀 클릭 시 인라인 편집 후 1초 뒤 자동 저장
          </p>
        </div>
        <AddMappingDialog>
          <Button className="bg-gradient-brand text-white hover:opacity-90">
            <Plus className="h-4 w-4 mr-1" />
            새 매핑
          </Button>
        </AddMappingDialog>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            등록된 매핑이 없습니다.
          </CardContent>
        </Card>
      ) : (
        <MappingTable rows={rows} />
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다. 모든 편집은 audit_logs에 기록됩니다.
      </p>
    </div>
  );
}
