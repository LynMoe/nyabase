import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import type { GroupMemberDto } from '@nyabase/common';
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

export type CatalogUser = {
  id: string;
  username: string;
  displayName: string;
  status: string;
};

export function GroupMembersTab({
  members,
  canManage,
  onAdd,
  onRemove,
}: {
  members: GroupMemberDto[];
  canManage: boolean;
  onAdd: () => void;
  onRemove: (member: { userId: string; label: string }) => void;
}) {
  return (
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
  );
}

export function AddGroupMemberDialog({
  candidates,
  usersQuery,
  pending,
  onSubmit,
  onOpenChange,
}: {
  candidates: CatalogUser[];
  usersQuery: { isLoading: boolean; isError: boolean; refetch: () => void };
  pending: boolean;
  onSubmit: (userId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
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
              onClick={() => { usersQuery.refetch(); }}
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
              onClick={() => onSubmit(memberUserId)}
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
