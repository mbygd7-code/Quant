'use client';

import { useMemo, useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface Row {
  id: number;
  date: string;
  channel: string;
  recipient: string | null;
  status: string;
  error: string | null;
  sent_at: string;
}

const STATUS_TONE: Record<string, string> = {
  sent: 'text-txt-primary border-status-success/30',
  failed: 'text-status-error border-status-error/30',
  dry_run: 'text-txt-secondary',
};

function maskRecipient(s: string | null): string {
  if (!s) return '—';
  return s
    .split(',')
    .map((part) => (part.length > 6 ? `${part.slice(0, 3)}***${part.slice(-2)}` : '***'))
    .join(', ');
}

export function NotificationsTable({ rows }: { rows: Row[] }) {
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (channelFilter !== 'all' && r.channel !== channelFilter) return false;
      return true;
    });
  }, [rows, statusFilter, channelFilter]);

  const channels = Array.from(new Set(rows.map((r) => r.channel)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[120px]">
            <SelectValue placeholder="상태" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 상태</SelectItem>
            <SelectItem value="sent">성공</SelectItem>
            <SelectItem value="failed">실패</SelectItem>
            <SelectItem value="dry_run">DRY_RUN</SelectItem>
          </SelectContent>
        </Select>
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="채널" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 채널</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-xs text-txt-muted">{filtered.length} / {rows.length}</span>
      </div>

      <div className="rounded-md border border-border bg-bg-secondary/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[100px]">날짜</TableHead>
              <TableHead className="w-[80px]">채널</TableHead>
              <TableHead>수신자</TableHead>
              <TableHead className="w-[80px]">상태</TableHead>
              <TableHead>에러</TableHead>
              <TableHead className="w-[100px]">시간</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.date}</TableCell>
                <TableCell className="text-xs">{r.channel}</TableCell>
                <TableCell className="font-mono text-xs text-txt-muted">{maskRecipient(r.recipient)}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={STATUS_TONE[r.status] ?? ''}>{r.status}</Badge>
                </TableCell>
                <TableCell className="text-xs text-status-error truncate max-w-[200px]" title={r.error ?? ''}>
                  {r.error ?? '—'}
                </TableCell>
                <TableCell className="text-xs text-txt-muted">
                  {new Date(r.sent_at).toLocaleString('ko-KR')}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
