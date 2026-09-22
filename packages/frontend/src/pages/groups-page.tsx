import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { Capability, zCreateGroupRequest, type CreateGroupRequest, type GroupDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { capabilityLabel } from '../lib/display-labels.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { isPermanentQueryError } from '../lib/query-lifecycle.js';

export default function GroupsPage() {
  const canManageGroups = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageGroups) ?? false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteGroup, setDeleteGroup] = useState<GroupDto | null>(null);
  const groupsQuery = useQuery({
    queryKey: queryKeys.groups.admin,
    queryFn: () => api.get<GroupDto[]>('/admin/groups'),
    retry: (count, error) => !isPermanentQueryError(error) && count < 1,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/admin/groups/${id}`),
    onSuccess: () => {
      toast({ title: '用户组已删除' });
      setDeleteGroup(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
    },
    onError: (error) => toast({ title: '删除用户组失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="groups-management">
      <PageHeader
        title="用户组"
        description={
          groupsQuery.data && groupsQuery.data.length > 0
            ? `${groupsQuery.data.length} 个用户组`
            : undefined
        }
        actions={
          canManageGroups ? (
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户组</Button>
          ) : undefined
        }
      />
      <QueryView
        query={groupsQuery}
        resourceName="用户组"
        loadingLabel="加载用户组..."
        showEmpty={groupsQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无用户组。"
            action={
              canManageGroups ? (
                <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户组</Button>
              ) : undefined
            }
          />
        }
      >
        {(groups) => (
          <SectionCard flush>
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead>名称</TableHead>
                  <TableHead>成员</TableHead>
                  <TableHead>能力</TableHead>
                  {canManageGroups ? <TableHead className="text-right">操作</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((group) => (
                  <TableRow key={group.id}>
                    <TableCell className="whitespace-normal">
                      <Link
                        to="/groups/$id"
                        params={{ id: group.id }}
                        search={{ tab: 'overview' }}
                        className="block min-w-0"
                      >
                        <p className="font-medium">{group.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {group.isSystem ? '系统组' : group.description ?? '无描述'}
                        </p>
                      </Link>
                    </TableCell>
                    <TableCell>{group.memberCount ?? group.members?.length ?? 0}</TableCell>
                    <TableCell className="whitespace-normal">
                      <div className="flex flex-wrap gap-1">
                        {group.capabilities.length === 0
                          ? <span className="text-muted-foreground">无</span>
                          : group.capabilities.map((capability) => (
                            <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
                          ))}
                      </div>
                    </TableCell>
                    {canManageGroups ? (
                      <TableCell className="text-right">
                        <Button size="sm" variant="destructive" disabled={group.isSystem} onClick={() => setDeleteGroup(group)}>
                          <Trash2 className="h-4 w-4" />删除
                        </Button>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        )}
      </QueryView>
      {canManageGroups && <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} />}
      <ConfirmDialog
        open={Boolean(deleteGroup)}
        title="删除用户组？"
        description="系统组不可删除。删除后成员关系与资源授权会一并清理，且不可恢复。"
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={remove.isPending}
        onConfirm={() => { if (deleteGroup) remove.mutate(deleteGroup.id); }}
        onOpenChange={(open) => { if (!open) setDeleteGroup(null); }}
      />
    </Page>
  );
}

function CreateGroupDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: CreateGroupRequest) => api.post<GroupDto>('/admin/groups', body),
    onSuccess: () => {
      toast({ title: '用户组已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError)),
  });
  const submit = () => {
    const parsed = zCreateGroupRequest.safeParse({ name: name.trim(), description: description.trim() || undefined });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查用户组信息');
      return;
    }
    create.mutate(parsed.data);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建用户组</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <FormField id="new-group-name" label="名称">
            <Input id="new-group-name" value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField id="new-group-description" label="描述">
            <Input id="new-group-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </FormField>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit} disabled={create.isPending}>{create.isPending ? '创建中...' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
