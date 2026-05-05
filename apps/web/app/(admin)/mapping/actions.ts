'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { getAdminWriteClient, recordAudit } from '@/lib/audit';
import { RELATION_TYPES } from './constants';

const updateSchema = z.object({
  id: z.number().int().positive(),
  patch: z.object({
    relation_type: z.enum(RELATION_TYPES).optional(),
    impact_strength: z.number().min(0).max(1).optional(),
    rationale: z.string().max(1000).optional(),
  }),
});

const insertSchema = z.object({
  us_symbol: z.string().min(1).max(10),
  kr_ticker: z.string().min(1).max(10),
  relation_type: z.enum(RELATION_TYPES),
  impact_strength: z.number().min(0).max(1),
  rationale: z.string().max(1000).optional(),
});

export async function updateMapping(
  raw: z.infer<typeof updateSchema>,
): Promise<{ ok?: true; error?: string }> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const { data: before } = await sb
    .from('us_kr_mapping')
    .select('*')
    .eq('id', parsed.data.id)
    .maybeSingle();
  const { error, data: after } = await sb
    .from('us_kr_mapping')
    .update({ ...parsed.data.patch, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .select()
    .maybeSingle();
  if (error) return { error: error.message };

  await recordAudit({
    action: 'mapping.update',
    resource_type: 'us_kr_mapping',
    resource_id: String(parsed.data.id),
    changes: { before, after },
  });
  revalidatePath('/mapping');
  return { ok: true };
}

export async function createMapping(
  raw: z.infer<typeof insertSchema>,
): Promise<{ ok?: true; error?: string; id?: number }> {
  const parsed = insertSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const { error, data } = await sb
    .from('us_kr_mapping')
    .insert(parsed.data)
    .select()
    .maybeSingle();
  if (error) return { error: error.message };

  await recordAudit({
    action: 'mapping.create',
    resource_type: 'us_kr_mapping',
    resource_id: data?.id ? String(data.id) : undefined,
    changes: { after: data },
  });
  revalidatePath('/mapping');
  return { ok: true, id: data?.id as number };
}

export async function deleteMapping(id: number): Promise<{ ok?: true; error?: string }> {
  const sb = getAdminWriteClient();
  const { data: before } = await sb
    .from('us_kr_mapping')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  const { error } = await sb.from('us_kr_mapping').delete().eq('id', id);
  if (error) return { error: error.message };

  await recordAudit({
    action: 'mapping.delete',
    resource_type: 'us_kr_mapping',
    resource_id: String(id),
    changes: { before },
  });
  revalidatePath('/mapping');
  return { ok: true };
}

