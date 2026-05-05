'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getAdminWriteClient, recordAudit } from '@/lib/audit';

const weightSchema = z.object({
  version: z.string().min(3).max(20),
  notes: z.string().min(10, '변경 사유 10자 이상'),
  global_market_weight: z.number().min(0).max(1),
  sector_weight: z.number().min(0).max(1),
  related_us_stock_weight: z.number().min(0).max(1),
  news_sentiment_weight: z.number().min(0).max(1),
  fundamental_weight: z.number().min(0).max(1),
  volume_flow_weight: z.number().min(0).max(1),
  risk_penalty_weight: z.number().min(0).max(1),
  signal_threshold_strong: z.number().min(0).max(1),
  signal_threshold_interest: z.number().min(0).max(1),
  signal_threshold_neutral: z.number().min(0).max(1),
  signal_threshold_caution: z.number().min(0).max(1),
});
type WeightInput = z.infer<typeof weightSchema>;

function validateBusinessRules(d: WeightInput): string | null {
  const sum =
    d.global_market_weight +
    d.sector_weight +
    d.related_us_stock_weight +
    d.news_sentiment_weight +
    d.fundamental_weight +
    d.volume_flow_weight +
    d.risk_penalty_weight;
  if (Math.abs(sum - 1.0) > 0.001) {
    return `가중치 합계가 1.00이 아닙니다 (현재 ${sum.toFixed(3)})`;
  }
  if (
    !(
      d.signal_threshold_strong > d.signal_threshold_interest &&
      d.signal_threshold_interest > d.signal_threshold_neutral &&
      d.signal_threshold_neutral > d.signal_threshold_caution
    )
  ) {
    return '임계값은 단조 감소여야 합니다 (강한 관심 > 관심 > 관망 > 주의)';
  }
  return null;
}

export async function saveWeightConfig(
  raw: WeightInput,
): Promise<{ ok?: true; error?: string; id?: string }> {
  const parsed = weightSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const ruleError = validateBusinessRules(parsed.data);
  if (ruleError) return { error: ruleError };

  const sb = getAdminWriteClient();
  const { error, data } = await sb
    .from('weight_configs')
    .insert({ ...parsed.data, is_active: false })
    .select()
    .maybeSingle();
  if (error) return { error: error.message };

  await recordAudit({
    action: 'weights.create',
    resource_type: 'weight_configs',
    resource_id: data?.id ? String(data.id) : undefined,
    changes: { after: data },
  });
  revalidatePath('/weights');
  return { ok: true, id: data?.id as string };
}

export async function activateWeightConfig(
  id: string,
): Promise<{ ok?: true; error?: string }> {
  const sb = getAdminWriteClient();
  // 1. deactivate currently active
  const { error: e1 } = await sb
    .from('weight_configs')
    .update({ is_active: false })
    .eq('is_active', true);
  if (e1) return { error: e1.message };

  // 2. activate target
  const { error: e2, data } = await sb
    .from('weight_configs')
    .update({ is_active: true })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (e2) return { error: e2.message };

  await recordAudit({
    action: 'weights.activate',
    resource_type: 'weight_configs',
    resource_id: id,
    changes: { after: data },
  });
  revalidatePath('/weights');
  return { ok: true };
}
