import { notFound } from 'next/navigation';

import { getQueryClient } from '@/lib/supabase/query-client';
import { ChunkEditor } from '@/components/admin/chunk-editor';

export const dynamic = 'force-dynamic';

export default async function ChunkEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = await getQueryClient();
  const { data: chunk } = await sb
    .from('rag_chunks')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!chunk) notFound();

  return (
    <ChunkEditor
      mode="edit"
      initial={{
        id: chunk.id as string,
        topic: chunk.topic as string,
        markets: (chunk.markets as string[]) ?? [],
        sectors: (chunk.sectors as string[]) ?? [],
        related_tickers: (chunk.related_tickers as string[]) ?? [],
        trigger_conditions: (chunk.trigger_conditions as string[]) ?? [],
        positive_signal: (chunk.positive_signal as string | null) ?? '',
        risk_warning: (chunk.risk_warning as string | null) ?? '',
        body: (chunk.body as string) ?? '',
      }}
    />
  );
}
