import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { Role, type GroupMemberDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { FormField } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { useCatalogUsers, useGroupMembers, useInvalidateGroup } from '../../lib/group-queries.js';
import { useHasRole } from '../../lib/use-role.js';

export function GroupMembersTab({ groupId, memberFallback }: { groupId: string; memberFallback: GroupMemberDto[] }) {
  const canManage = useHasRole(Role.Admin);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; label: string } | null>(null);
  const members = useGroupMembers(groupId, canManage).data ?? memberFallback;
  const invalidate = useInvalidateGroup(groupId);
  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete<void>(`/admin/groups/${groupId}/members/${userId}`),
    onSuccess: () => {
      toast({ title: '已移除成员' });
      setRemoveTarget(null);
      invalidate();
    },
    onError: (error) => toast({ title: '移除成员失败', description: errorMessage(error), variant: 'destructive' }),
  });
  // Warm the user list so the add dialog opens already filled.
  useCatalogUsers(canManage);
  const onAdd = () => setAddOpen(true);
  const onRemove = setRemoveTarget;
  return (
    <>
    <SectionCard
      title="成员"
      description={
        canManage
          ? undefined
          : '成员列表只读；需要「管理用户组」权限才能增删成员。'
      }
      actions={canManage ? (
        <Button size="sm" onClick={onAdd} data-testid="group-add-member-open">
          <Plus className="h-4 w-4" />添加成员
        </Button>
      ) : undefined}
      flush={members.length > 0}
      testId="group-members"
    >
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无成员。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>用户</TableHead>
              <TableHead>用户名</TableHead>
              {canManage ? <TableHead className="text-right">操作</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.userId}>
                <TableCell className="whitespace-normal">
                  <Link
                    to="/users/$id"
                    params={{ id: member.userId }}
                    search={{ tab: 'overview' }}
                    className="font-medium"
                  >
                    {member.displayName}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  @{member.username}
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onRemove({
                        userId: member.userId,
                        label: `${member.displayName} (@${member.username})`,
                      })}
                    >
                      移除
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionCard>
    {addOpen ? (
      <AddGroupMemberDialog
        groupId={groupId}
        memberIds={new Set(members.map((member) => member.userId))}
        onClose={() => setAddOpen(false)}
      />
    ) : null}
    <ConfirmDialog
      open={Boolean(removeTarget)}
      title="移除成员？"
      description={`将把「${removeTarget?.label}」移出本组。该用户将立即失去本组带来的授权（若仍有其他授权则不受影响）。`}
      confirmLabel="确认移除"
      pendingLabel="移除中..."
      pending={removeMember.isPending}
      onConfirm={() => { if (removeTarget) removeMember.mutate(removeTarget.userId); }}
      onOpenChange={(open) => { if (!open) setRemoveTarget(null); }}
    />
    </>
  );
}

function AddGroupMemberDialog({
  groupId,
  memberIds,
  onClose,
}: {
  groupId: string;
  memberIds: ReadonlySet<string>;
  onClose: () => void;
}) {
  const usersQuery = useCatalogUsers(true);
  const invalidate = useInvalidateGroup(groupId);
  const addMember = useMutation({
    mutationFn: (userId: string) => api.post<{ changed: boolean }>(`/admin/groups/${groupId}/members`, { userId }),
    onSuccess: () => {
      toast({ title: '已添加成员' });
      onClose();
      invalidate();
    },
    onError: (error) => toast({ title: '添加成员失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const pending = addMember.isPending;
  const candidates = (usersQuery.data ?? []).filter((user) => !memberIds.has(user.id));
  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  const [memberUserId, setMemberUserId] = useState('');
  const canChoose = !usersQuery.isLoading && !usersQuery.isError && candidates.length > 0;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
        </DialogHeader>
        {usersQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">加载用户…</p>
        ) : usersQuery.isError ? (
          <p className="text-sm text-destructive">
            无法加载可选用户列表。
            <button
              type="button"
              className="ml-2 underline"
              onClick={() => { void usersQuery.refetch(); }}
            >
              重试
            </button>
          </p>
        ) : canChoose ? (
          <FormField id="group-add-member" label="用户">
            <Select
              key={memberUserId || 'empty'}
              value={memberUserId || undefined}
              onValueChange={setMemberUserId}
              disabled={pending}
            >
              <SelectTrigger id="group-add-member">
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.displayName} (@{user.username})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : (
          <p className="text-sm text-muted-foreground">没有可添加的用户。</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{canChoose ? '取消' : '关闭'}</Button>
          {canChoose ? (
            <Button
              onClick={() => addMember.mutate(memberUserId)}
              disabled={!memberUserId || pending}
            >
              {pending ? '添加中...' : '添加'}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
