'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare, Shield, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

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
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  deleteUser,
  disconnectUserTelegram,
  updateUserRole,
} from '@/app/(admin)/admin/users/actions';

interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  role: 'admin' | 'beta' | 'user';
  telegram_chat_id: string | null;
  notification_enabled: boolean | null;
  created_at: string;
}

const ROLE_TONE: Record<UserRow['role'], string> = {
  admin: 'text-txt-primary border-brand-purple/30',
  beta: 'text-txt-primary border-status-success/30',
  user: 'text-txt-secondary',
};

export function UsersTable({ rows }: { rows: UserRow[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ user: UserRow; step: 1 | 2 } | null>(null);
  const [deleteEmailInput, setDeleteEmailInput] = useState('');
  const [pending, startTransition] = useTransition();

  function closeDelete() {
    setConfirmDelete(null);
    setDeleteEmailInput('');
  }

  function handleRoleChange(role: UserRow['role']) {
    if (!editing) return;
    startTransition(async () => {
      const res = await updateUserRole(editing.id, { role });
      if (res.error) toast.error(`역할 변경 실패: ${res.error}`);
      else {
        toast.success(`${editing.email} → ${role}`);
        router.refresh();
      }
      setEditing(null);
    });
  }

  function handleDisconnectTelegram(user: UserRow) {
    startTransition(async () => {
      const res = await disconnectUserTelegram(user.id);
      if (res.error) toast.error(`해제 실패: ${res.error}`);
      else {
        toast.success(`${user.email} 텔레그램 연동 해제됨`);
        router.refresh();
      }
    });
  }

  function handleDelete(user: UserRow) {
    startTransition(async () => {
      const res = await deleteUser(user.id);
      if (res.error) toast.error(`삭제 실패: ${res.error}`);
      else {
        toast.success(`${user.email} 삭제됨`);
        router.refresh();
      }
      closeDelete();
    });
  }

  return (
    <>
      <div className="rounded-md border border-border bg-bg-secondary/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>이메일</TableHead>
              <TableHead className="w-[80px]">권한</TableHead>
              <TableHead className="w-[100px]">텔레그램</TableHead>
              <TableHead className="w-[140px]">가입일</TableHead>
              <TableHead className="w-[160px] text-right">액션</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="font-medium">{u.email}</div>
                  {u.display_name && (
                    <div className="text-[11px] text-txt-muted">{u.display_name}</div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={ROLE_TONE[u.role]}>{u.role}</Badge>
                </TableCell>
                <TableCell>
                  {u.telegram_chat_id ? (
                    <span className="text-txt-primary text-xs">🟢 연동됨</span>
                  ) : (
                    <span className="text-txt-muted text-xs">⚪ 미연동</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-txt-muted">
                  {new Date(u.created_at).toLocaleDateString('ko-KR')}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      title="역할 변경"
                      onClick={() => setEditing(u)}
                    >
                      <Shield className="h-3.5 w-3.5" />
                    </Button>
                    {u.telegram_chat_id && (
                      <Button
                        size="icon"
                        variant="ghost"
                        title="텔레그램 강제 해제"
                        onClick={() => handleDisconnectTelegram(u)}
                      >
                        <MessageSquare className="h-3.5 w-3.5 text-status-warning" />
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      title="삭제"
                      onClick={() => setConfirmDelete({ user: u, step: 1 })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-status-error" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Role change dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>역할 변경</DialogTitle>
            <DialogDescription>
              {editing?.email} (현재: <span className="text-txt-primary">{editing?.role}</span>)
            </DialogDescription>
          </DialogHeader>
          <Select onValueChange={(v) => handleRoleChange(v as UserRow['role'])}>
            <SelectTrigger>
              <SelectValue placeholder="새 역할 선택" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="admin">admin</SelectItem>
              <SelectItem value="beta">beta</SelectItem>
              <SelectItem value="user">user</SelectItem>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>취소</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Two-step delete confirmation */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && closeDelete()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>사용자 삭제 ({confirmDelete?.step}/2)</DialogTitle>
            <DialogDescription>
              {confirmDelete?.step === 1 ? (
                <>
                  <strong>{confirmDelete.user.email}</strong>의 계정을 영구 삭제합니다.<br />
                  관련 데이터(watchlist, paper_trades 등)가 모두 cascade 삭제됩니다.
                </>
              ) : (
                <>
                  마지막 확인입니다. 정말로 <strong>{confirmDelete?.user.email}</strong>를{' '}
                  <span className="text-status-error">영구 삭제</span>하시겠습니까?
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {confirmDelete?.step === 2 && (
            <Input
              placeholder={`확인을 위해 ${confirmDelete.user.email} 입력`}
              value={deleteEmailInput}
              onChange={(e) => setDeleteEmailInput(e.target.value)}
              autoFocus
              id="delete_confirm"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeDelete}>취소</Button>
            {confirmDelete?.step === 1 ? (
              <Button
                variant="destructive"
                onClick={() => setConfirmDelete({ user: confirmDelete.user, step: 2 })}
              >
                다음
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={pending || deleteEmailInput !== confirmDelete?.user.email}
                onClick={() => confirmDelete && handleDelete(confirmDelete.user)}
              >
                {pending ? '삭제 중...' : '영구 삭제'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
