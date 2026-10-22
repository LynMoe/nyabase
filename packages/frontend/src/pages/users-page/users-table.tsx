import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Trash2 } from 'lucide-react';
import { Role, type UserDto } from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { roleLabel, userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { useAuthStore } from '../../store/auth.js';
import { useHasRole } from '../../lib/use-role.js';
import { type ActionAvailability, userActionAvailability } from '../../lib/user-administration.js';

function DeleteUserButton({ availability, onDelete }: { availability: ActionAvailability; onDelete: () => void }) {
  return (
    <Button
      size="sm"
      variant="ghost-destructive"
      disabled={!availability.allowed}
      title={availability.reason ?? undefined}
      onClick={onDelete}
    >
      <Trash2 className="h-4 w-4" />删除
    </Button>
  );
}

/** `users` are the rows to show; `allUsers` is the full list the last-admin rule is evaluated against. */
export function UsersTable({ users: visibleUsers, allUsers }: { users: UserDto[]; allUsers: UserDto[] }) {
  const viewer = useAuthStore((state) => state.user);
  const canManage = useHasRole(Role.Admin);
  const queryClient = useQueryClient();
  const [deleteUser, setDeleteUser] = useState<UserDto | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/users/${id}`),
    onSuccess: () => {
      toast({ title: '用户已删除' });
      setDeleteUser(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
    },
    onError: (error) => toast({ title: '删除用户失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <>
      <Table className="min-w-[720px]">
        <TableHeader>
          <TableRow>
            <TableHead>用户</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>用户组</TableHead>
            {canManage ? <TableHead className="text-right">操作</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleUsers.length === 0 ? (
            <TableRow>
              <TableCell colSpan={canManage ? 5 : 4} className="py-8 text-center text-muted-foreground">
                没有符合条件的用户
              </TableCell>
            </TableRow>
          ) : null}
          {visibleUsers.map((user) => (
            <TableRow key={user.id}>
              <TableCell className="whitespace-normal">
                <Link
                  to="/users/$id"
                  params={{ id: user.id }}
                  search={{ tab: 'overview' }}
                  className="block min-w-0"
                >
                  <p className="font-medium">{user.displayName}</p>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">@{user.username}</p>
                </Link>
              </TableCell>
              <TableCell>{roleLabel(user.role)}</TableCell>
              <TableCell>
                <StatusBadge
                  label={userStatusLabel(user.status)}
                  pending={userDeleting(user.status)}
                  variant={user.status === 'active' ? 'success' : 'secondary'}
                />
              </TableCell>
              <TableCell className="whitespace-normal">
                <div className="flex flex-wrap gap-1">
                  {user.groups.length === 0
                    ? <span className="text-muted-foreground">无</span>
                    : user.groups.map((group) => (
                      <Link
                        key={group.id}
                        to="/groups/$id"
                        params={{ id: group.id }}
                        search={{ tab: 'overview' }}
                      >
                        <Badge variant="outline">{group.name}</Badge>
                      </Link>
                    ))}
                </div>
              </TableCell>
              {canManage ? (
                <TableCell className="text-right">
                  {user.id !== viewer?.id ? (
                    <DeleteUserButton
                      availability={userActionAvailability(viewer, user, allUsers).delete}
                      onDelete={() => setDeleteUser(user)}
                    />
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={Boolean(deleteUser)}
        title="删除用户？"
        description={`将永久删除用户「${deleteUser?.displayName}」。其登录会话会被终止，组关系与资源授权会一并清理，且不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => { if (deleteUser) remove.mutate(deleteUser.id); }}
        onOpenChange={(open) => { if (!open) setDeleteUser(null); }}
      />
    </>
  );
}
