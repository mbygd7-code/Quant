'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function KnowledgeFilters({
  sectors,
  initialQuery,
  initialSector,
}: {
  sectors: string[];
  initialQuery: string;
  initialSector: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [, startTransition] = useTransition();
  const [query, setQuery] = useState(initialQuery);

  function update(next: { q?: string; sector?: string }) {
    const sp = new URLSearchParams(params);
    if (next.q !== undefined) {
      if (next.q) sp.set('q', next.q);
      else sp.delete('q');
    }
    if (next.sector !== undefined) {
      if (next.sector && next.sector !== 'all') sp.set('sector', next.sector);
      else sp.delete('sector');
    }
    startTransition(() => router.push(`/knowledge?${sp.toString()}`));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        placeholder="topic, body, id 검색..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && update({ q: query })}
        onBlur={() => update({ q: query })}
        className="max-w-sm"
      />
      <Select
        defaultValue={initialSector}
        onValueChange={(v) => update({ sector: v })}
      >
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="섹터" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">전체 섹터</SelectItem>
          {sectors.map((s) => (
            <SelectItem key={s} value={s}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
