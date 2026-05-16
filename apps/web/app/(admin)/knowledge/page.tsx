import Link from 'next/link';
import { Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { getQueryClient } from '@/lib/supabase/query-client';
import { KnowledgeFilters } from '@/components/admin/knowledge-filters';

export const dynamic = 'force-dynamic';

interface SearchParams {
  q?: string;
  sector?: string;
}

export default async function KnowledgeListPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { q, sector } = await searchParams;
  const sb = await getQueryClient();

  let queryBuilder = sb
    .from('rag_chunks')
    .select('id, topic, sectors, related_tickers, positive_signal, created_at, body')
    .order('created_at', { ascending: false });

  if (q && q.trim().length > 0) {
    const term = q.trim();
    queryBuilder = queryBuilder.or(
      `topic.ilike.%${term}%,body.ilike.%${term}%,id.ilike.%${term}%`,
    );
  }
  if (sector && sector !== 'all') {
    queryBuilder = queryBuilder.contains('sectors', [sector]);
  }

  const { data } = await queryBuilder;
  const chunks = (data ?? []) as Array<{
    id: string;
    topic: string;
    sectors: string[] | null;
    related_tickers: string[] | null;
    positive_signal: string | null;
    created_at: string;
    body: string;
  }>;

  const allSectors = Array.from(
    new Set(chunks.flatMap((c) => c.sectors ?? [])),
  ).sort();

  return (
    <div className="space-y-5 fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">Knowledge Base</h1>
          <p className="mt-1 text-sm text-txt-secondary">
            {chunks.length} 청크 · 투자 판단 단위 RAG 지식
          </p>
        </div>
        <Button asChild className="bg-gradient-brand text-white hover:opacity-90">
          <Link href="/knowledge/new">
            <Plus className="h-4 w-4 mr-1" />
            새 청크
          </Link>
        </Button>
      </div>

      <KnowledgeFilters sectors={allSectors} initialQuery={q ?? ''} initialSector={sector ?? 'all'} />

      {chunks.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-txt-secondary">
            등록된 청크가 없습니다.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {chunks.map((c) => (
            <Link
              key={c.id}
              href={`/knowledge/${c.id}`}
              className="group rounded-md border border-border bg-bg-secondary/60 hover:bg-bg-tertiary/70 hover:border-hover-strong p-4 transition-colors"
            >
              <div className="text-[10px] font-mono text-txt-muted">{c.id}</div>
              <div className="mt-1 font-medium text-txt-primary line-clamp-2">{c.topic}</div>
              <div className="mt-2 text-xs text-txt-secondary line-clamp-2">{c.body}</div>
              <div className="mt-3 flex flex-wrap gap-1">
                {(c.sectors ?? []).map((s) => (
                  <Badge key={s} variant="outline" className="text-[10px]">{s}</Badge>
                ))}
                {(c.related_tickers ?? []).slice(0, 4).map((t) => (
                  <Badge key={t} variant="outline" className="text-[10px] font-mono">{t}</Badge>
                ))}
              </div>
              {c.positive_signal && (
                <div className="mt-2 text-[11px] text-txt-primary">신호: {c.positive_signal}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
