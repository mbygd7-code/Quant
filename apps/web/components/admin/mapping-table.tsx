'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RELATION_TYPES, RELATION_LABELS, type RelationType } from '@/app/(admin)/mapping/constants';
import { deleteMapping, updateMapping } from '@/app/(admin)/mapping/actions';

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

const DEBOUNCE_MS = 1000;

export function MappingTable({ rows }: { rows: Row[] }) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [confirmDelete, setConfirmDelete] = useState<Row | null>(null);
  const [, startTransition] = useTransition();

  // local edits keyed by id; debounced flush to server
  const [edits, setEdits] = useState<Record<number, Partial<Row>>>({});
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    const t = timers.current;
    return () => {
      Object.values(t).forEach(clearTimeout);
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter !== 'all' && r.relation_type !== typeFilter) return false;
      if (!q) return true;
      return (
        r.us_symbol.toLowerCase().includes(q) ||
        r.kr_ticker.toLowerCase().includes(q) ||
        (r.kr_name ?? '').toLowerCase().includes(q) ||
        (r.kr_sector ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, query, typeFilter]);

  function scheduleFlush(id: number, patch: Partial<Row>) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    if (timers.current[id]) clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      startTransition(async () => {
        const serverPatch: {
          relation_type?: RelationType;
          impact_strength?: number;
          rationale?: string;
        } = {};
        const e = { ...edits[id], ...patch };
        if (e.relation_type !== undefined) serverPatch.relation_type = e.relation_type as RelationType;
        if (e.impact_strength !== undefined) serverPatch.impact_strength = e.impact_strength;
        if (e.rationale !== undefined) serverPatch.rationale = e.rationale ?? '';

        const res = await updateMapping({ id, patch: serverPatch });
        if (res.error) {
          toast.error(`저장 실패: ${res.error}`);
        } else {
          toast.success(`저장됨 (id ${id})`);
        }
      });
    }, DEBOUNCE_MS);
  }

  function cellValue<K extends keyof Row>(row: Row, key: K): Row[K] {
    const e = edits[row.id];
    if (e && key in e && e[key] !== undefined) return e[key] as Row[K];
    return row[key];
  }

  async function handleDelete(row: Row) {
    const res = await deleteMapping(row.id);
    if (res.error) toast.error(`삭제 실패: ${res.error}`);
    else toast.success(`삭제됨: ${row.us_symbol} → ${row.kr_ticker}`);
    setConfirmDelete(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="US 심볼, KR 티커, 종목명, 섹터..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="관계 유형" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 유형</SelectItem>
            {RELATION_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{RELATION_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-txt-muted">{filtered.length} / {rows.length}</span>
      </div>

      <div className="rounded-md border border-border overflow-hidden bg-bg-secondary/60">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">US</TableHead>
              <TableHead className="w-[180px]">KR 종목</TableHead>
              <TableHead className="w-[120px]">섹터</TableHead>
              <TableHead className="w-[180px]">관계</TableHead>
              <TableHead className="w-[280px]">Impact</TableHead>
              <TableHead className="w-[60px] text-right">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-sm">{r.us_symbol}</TableCell>
                <TableCell>
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{r.kr_name ?? '—'}</span>
                    <span className="text-[11px] font-mono text-txt-muted">{r.kr_ticker}</span>
                  </div>
                </TableCell>
                <TableCell className="text-xs text-txt-secondary">{r.kr_sector ?? '—'}</TableCell>
                <TableCell>
                  <Select
                    value={(cellValue(r, 'relation_type') as string) ?? ''}
                    onValueChange={(v) => scheduleFlush(r.id, { relation_type: v })}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {RELATION_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{RELATION_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Slider
                      min={0}
                      max={1}
                      step={0.05}
                      value={[cellValue(r, 'impact_strength') as number]}
                      onValueChange={(v) => scheduleFlush(r.id, { impact_strength: v[0] })}
                      className="flex-1"
                    />
                    <span className="font-mono text-xs tabular-nums w-10 text-right">
                      {(cellValue(r, 'impact_strength') as number).toFixed(2)}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="삭제"
                    onClick={() => setConfirmDelete(r)}
                  >
                    <Trash2 className="h-4 w-4 text-status-error" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>매핑 삭제</DialogTitle>
            <DialogDescription>
              {confirmDelete && (
                <>
                  <strong>{confirmDelete.us_symbol}</strong> → <strong>{confirmDelete.kr_name ?? confirmDelete.kr_ticker}</strong>{' '}
                  매핑을 삭제합니다. 이 작업은 되돌릴 수 없습니다.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && handleDelete(confirmDelete)}
            >
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
