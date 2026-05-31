'use client';

/**
 * Approval queue table for /admin/users.
 *
 * Two variants:
 *   default (pending) — approve / reject / extend SLA buttons + D-N
 *                       remaining counter (skip Sat/Sun)
 *   terminal           — rejected & expired rows, with a "재승인" button
 *                       to short-circuit the user reapply path
 *
 * Mirrors the visual conventions of UsersTable so admins can hop
 * between the two without context switching.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CalendarClock, CheckCircle2, RotateCcw, XCircle } from 'lucide-react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  approveUser,
  rejectUser,
  extendApprovalSla,
} from '@/app/(admin)/admin/users/actions';

const APPROVAL_SLA_DAYS = 5;

type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  approval_status: ApprovalStatus;
  approval_note: string | null;
  created_at: string;
  reapplied_at: string | null;
  reapply_count: number;
}

interface Props {
  rows: UserRow[];
  variant?: 'default' | 'terminal';
}

export function ApprovalQueue({ rows, variant = 'default' }: Props) {
  const router = useRouter();
  const [approving, setApproving] = useState<UserRow | null>(null);
  const [approveRole, setApproveRole] = useState<'user' | 'beta'>('user');
  const [rejecting, setRejecting] = useState<UserRow | null>(null);
  const [rejectNote, setRejectNote] = useState('');
  const [pending, start] = useTransition();

  function handleApprove() {
    if (!approving) return;
    start(async () => {
      const res = await approveUser(approving.id, { role: approveRole });
      if (res.error) toast.error(`승인 실패: ${res.error}`);
      else {
        toast.success(`${approving.email} 승인됨 (${approveRole})`);
        router.refresh();
      }
      setApproving(null);
    });
  }

  function handleReject() {
    if (!rejecting) return;
    start(async () => {
      const res = await rejectUser(rejecting.id, { note: rejectNote });
      if (res.error) toast.error(`거절 실패: ${res.error}`);
      else {
        toast.success(`${rejecting.email} 거절됨`);
        router.refresh();
      }
      setRejecting(null);
      setRejectNote('');
    });
  }

  function handleExtend(user: UserRow) {
    start(async () => {
      const res = await extendApprovalSla(user.id);
      if (res.error) toast.error(`연장 실패: ${res.error}`);
      else {
        toast.success(`${user.email} 검토 기한 5영업일 재설정`);
        router.refresh();
      }
    });
  }

  return (
    <>
      <div className="rounded-md border border-border bg-bg-secondary/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>이메일</TableHead>
              {variant === 'default' ? (
                <TableHead className="w-[110px]">남은 영업일</TableHead>
              ) : (
                <TableHead className="w-[100px]">상태</TableHead>
              )}
              <TableHead className="w-[150px]">신청일</TableHead>
              <TableHead>사유 / 비고</TableHead>
              <TableHead className="w-[220px] text-right">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((u) => {
              const startedAt = u.reapplied_at ?? u.created_at;
              const remaining = remainingBusinessDays(new Date(startedAt));
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="font-medium">{u.email}</div>
                    {u.display_name && (
                      <div className="text-[11px] text-txt-muted">{u.display_name}</div>
                    )}
                    {u.reapply_count > 0 && (
                      <div className="mt-0.5 text-[10px] text-txt-muted">
                        재신청 {u.reapply_count}회
                      </div>
                    )}
                  </TableCell>
                  {variant === 'default' ? (
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          remaining <= 1
                            ? 'border-status-warning/40 text-status-warning'
                            : 'text-txt-primary'
                        }
                      >
                        D-{remaining}
                      </Badge>
                    </TableCell>
                  ) : (
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          u.approval_status === 'rejected'
                            ? 'border-status-error/40 text-status-error'
                            : 'border-status-warning/40 text-status-warning'
                        }
                      >
                        {u.approval_status === 'rejected' ? '거절' : '만료'}
                      </Badge>
                    </TableCell>
                  )}
                  <TableCell className="text-xs text-txt-muted">
                    {new Date(startedAt).toLocaleDateString('ko-KR')}
                  </TableCell>
                  <TableCell className="text-xs text-txt-secondary truncate max-w-[300px]">
                    {u.approval_note ?? '—'}
                  </TableCell>
                  <TableCell className="text-right">
                    {variant === 'default' ? (
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-status-success/40 text-status-success hover:bg-status-success/10 hover:text-status-success h-7 px-2 text-xs"
                          onClick={() => {
                            setApproveRole('user');
                            setApproving(u);
                          }}
                        >
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          승인
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-status-error/40 text-status-error hover:bg-status-error/10 hover:text-status-error h-7 px-2 text-xs"
                          onClick={() => setRejecting(u)}
                        >
                          <XCircle className="h-3 w-3 mr-1" />
                          거절
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="검토 기한 5영업일 재설정"
                          onClick={() => handleExtend(u)}
                        >
                          <CalendarClock className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setApproveRole('user');
                          setApproving(u);
                        }}
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        재승인
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Approve dialog — pick role first */}
      <Dialog open={!!approving} onOpenChange={(o) => !o && setApproving(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>사용자 승인</DialogTitle>
            <DialogDescription>
              {approving?.email} 을(를) 어떤 권한으로 승인할까요?
            </DialogDescription>
          </DialogHeader>
          <Select
            value={approveRole}
            onValueChange={(v) => setApproveRole(v as 'user' | 'beta')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">user (일반)</SelectItem>
              <SelectItem value="beta">beta (베타 테스터)</SelectItem>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproving(null)}>
              취소
            </Button>
            <Button
              disabled={pending}
              onClick={handleApprove}
              className="bg-gradient-brand text-white"
            >
              {pending ? '처리 중...' : '승인'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject dialog — note required */}
      <Dialog
        open={!!rejecting}
        onOpenChange={(o) => {
          if (!o) {
            setRejecting(null);
            setRejectNote('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>사용자 거절</DialogTitle>
            <DialogDescription>
              {rejecting?.email} — 거절 사유를 입력해주세요. 사용자에게 안내됩니다.
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="w-full rounded-md border border-border bg-bg-secondary p-2 text-sm min-h-[80px]"
            placeholder="예: 가족 계정 외 가입은 불가합니다."
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRejecting(null);
                setRejectNote('');
              }}
            >
              취소
            </Button>
            <Button
              variant="outline"
              disabled={pending || rejectNote.trim().length === 0}
              onClick={handleReject}
              className="border-status-error/40 text-status-error hover:bg-status-error/10 hover:text-status-error"
            >
              {pending ? '처리 중...' : '거절'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function remainingBusinessDays(start: Date): number {
  const now = new Date();
  let elapsed = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  while (cursor < today) {
    cursor.setDate(cursor.getDate() + 1);
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) elapsed += 1;
  }
  return Math.max(0, APPROVAL_SLA_DAYS - elapsed);
}
