'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import OpenAI from 'openai';

import { getAdminWriteClient, recordAudit } from '@/lib/audit';

const chunkSchema = z.object({
  id: z.string().min(3).max(50).regex(/^[a-z0-9_]+$/, 'lowercase + 숫자 + _ 만 허용'),
  topic: z.string().min(3).max(200),
  markets: z.array(z.string()).optional(),
  sectors: z.array(z.string()).optional(),
  related_tickers: z.array(z.string()).optional(),
  trigger_conditions: z.array(z.string()).optional(),
  positive_signal: z.string().nullable().optional(),
  risk_warning: z.string().nullable().optional(),
  body: z.string().min(10),
});
type ChunkInput = z.infer<typeof chunkSchema>;

const updateSchema = chunkSchema.omit({ id: true }).partial();

async function generateEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');
  const client = new OpenAI({ apiKey });
  const res = await client.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000), // safety: 8K char ≈ ~2K tokens, well under 8K-token limit
  });
  return res.data[0].embedding;
}

export async function createChunk(raw: ChunkInput): Promise<{ ok?: true; error?: string; id?: string }> {
  const parsed = chunkSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  let embedding: number[];
  try {
    embedding = await generateEmbedding(`${parsed.data.topic}\n\n${parsed.data.body}`);
  } catch (exc) {
    return { error: `임베딩 생성 실패: ${(exc as Error).message}` };
  }

  const sb = getAdminWriteClient();
  const { error, data } = await sb
    .from('rag_chunks')
    .insert({
      ...parsed.data,
      embedding: embedding as unknown as string, // pgvector accepts number[] via JSON
    })
    .select()
    .maybeSingle();
  if (error) return { error: error.message };

  await recordAudit({
    action: 'rag_chunk.create',
    resource_type: 'rag_chunks',
    resource_id: parsed.data.id,
    changes: { after: { ...parsed.data, embedding_len: embedding.length } },
  });
  revalidatePath('/knowledge');
  return { ok: true, id: data?.id as string };
}

export async function updateChunk(
  id: string,
  raw: z.infer<typeof updateSchema>,
): Promise<{ ok?: true; error?: string }> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.message };

  const sb = getAdminWriteClient();
  const { data: before } = await sb.from('rag_chunks').select('*').eq('id', id).maybeSingle();
  const { error, data: after } = await sb
    .from('rag_chunks')
    .update(parsed.data)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) return { error: error.message };

  await recordAudit({
    action: 'rag_chunk.update',
    resource_type: 'rag_chunks',
    resource_id: id,
    changes: {
      before: before ? { ...before, embedding: undefined } : null,
      after: after ? { ...after, embedding: undefined } : null,
    },
  });
  revalidatePath('/knowledge');
  revalidatePath(`/knowledge/${id}`);
  return { ok: true };
}

export async function regenerateEmbedding(id: string): Promise<{ ok?: true; error?: string }> {
  const sb = getAdminWriteClient();
  const { data: chunk } = await sb
    .from('rag_chunks')
    .select('id, topic, body')
    .eq('id', id)
    .maybeSingle();
  if (!chunk) return { error: '청크를 찾을 수 없습니다' };

  let embedding: number[];
  try {
    embedding = await generateEmbedding(`${chunk.topic}\n\n${chunk.body}`);
  } catch (exc) {
    return { error: `임베딩 생성 실패: ${(exc as Error).message}` };
  }
  const { error } = await sb
    .from('rag_chunks')
    .update({ embedding: embedding as unknown as string })
    .eq('id', id);
  if (error) return { error: error.message };

  await recordAudit({
    action: 'rag_chunk.regenerate_embedding',
    resource_type: 'rag_chunks',
    resource_id: id,
    changes: { embedding_len: embedding.length },
  });
  revalidatePath(`/knowledge/${id}`);
  return { ok: true };
}

export async function deleteChunk(id: string): Promise<void> {
  const sb = getAdminWriteClient();
  const { data: before } = await sb.from('rag_chunks').select('*').eq('id', id).maybeSingle();
  await sb.from('rag_chunks').delete().eq('id', id);
  await recordAudit({
    action: 'rag_chunk.delete',
    resource_type: 'rag_chunks',
    resource_id: id,
    changes: { before: before ? { ...before, embedding: undefined } : null },
  });
  revalidatePath('/knowledge');
  redirect('/knowledge');
}
