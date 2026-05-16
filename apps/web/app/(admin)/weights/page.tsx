import { getQueryClient } from '@/lib/supabase/query-client';
import { WeightsForm } from '@/components/admin/weights-form';
import { VersionHistory } from '@/components/admin/weights-version-history';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

interface WeightConfig {
  id: string;
  version: string;
  global_market_weight: number;
  sector_weight: number;
  related_us_stock_weight: number;
  news_sentiment_weight: number;
  fundamental_weight: number;
  volume_flow_weight: number;
  risk_penalty_weight: number;
  kr_fear_greed_weight: number;
  signal_threshold_strong: number;
  signal_threshold_interest: number;
  signal_threshold_neutral: number;
  signal_threshold_caution: number;
  is_active: boolean;
  notes: string | null;
  created_at: string;
}

export default async function WeightsPage() {
  const sb = await getQueryClient();
  const { data: configs } = await sb
    .from('weight_configs')
    .select('*')
    .order('created_at', { ascending: false });

  const list = (configs ?? []) as WeightConfig[];
  const active = list.find((c) => c.is_active) ?? list[0] ?? null;

  return (
    <div className="space-y-5 fade-in">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">가중치 · 임계값</h1>
        <p className="mt-1 text-sm text-txt-secondary">
          8요소 가중치 합계는 1.00, 임계값은 단조 감소여야 저장 가능
        </p>
      </div>

      {!active ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            등록된 가중치 설정이 없습니다. 첫 버전을 만들어 주세요.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[3fr_2fr]">
          <WeightsForm
            initial={{
              version: nextVersion(active.version),
              notes: '',
              global_market_weight: active.global_market_weight,
              sector_weight: active.sector_weight,
              related_us_stock_weight: active.related_us_stock_weight,
              news_sentiment_weight: active.news_sentiment_weight,
              fundamental_weight: active.fundamental_weight,
              volume_flow_weight: active.volume_flow_weight,
              risk_penalty_weight: active.risk_penalty_weight,
              kr_fear_greed_weight: active.kr_fear_greed_weight ?? 0.05,
              signal_threshold_strong: active.signal_threshold_strong,
              signal_threshold_interest: active.signal_threshold_interest,
              signal_threshold_neutral: active.signal_threshold_neutral,
              signal_threshold_caution: active.signal_threshold_caution,
            }}
          />
          <VersionHistory configs={list} activeId={active.id} />
        </div>
      )}

      <p className="text-xs text-txt-muted">
        본 정보는 투자 판단 보조 자료이며 매매 권유가 아닙니다.
      </p>
    </div>
  );
}

function nextVersion(current: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return today === current ? `${today}-r2` : today;
}
