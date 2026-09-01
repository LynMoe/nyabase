import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Shield, Trash2 } from 'lucide-react';
import { Capability, zCreateGroupRequest, type CreateGroupRequest, type GroupDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ResourceList, ResourceListRow } from '../components/layout/resource-list.js';
import { CanonicalGrantPanel } from '../components/grants/canonical-grant-panel.js';
import { SubjectGrantSummary } from '../components/grants/subject-grant-summary.js';
import { capabilityLabel } from '../lib/display-labels.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { isPermanentQueryError } from '../lib/query-lifecycle.js';

export default function GroupsPage() {
  const canManageGroups = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageGroups) ?? false);
  const canManageGrants = useAuthStore((state) => state.user?.capabilities.includes(Capability.ManageGrants) ?? false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [grantGroup, setGrantGroup] = useState<GroupDto | null>(null);
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
          groupsQuery.data
            ? `${groupsQuery.data.length} 个用户组 · 授权按资源范围管理`
            : '授权按资源范围管理'
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
          <ResourceList>
            {groups.map((group) => (
              <ResourceListRow key={group.id}>
                <Link to="/groups/$id" params={{ id: group.id }} className="flex min-w-0 flex-1 items-center gap-3 rounded-md outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring">
                  <Shield className="h-5 w-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">{group.name}</p>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {group.description ?? '无描述'} · {group.memberCount ?? group.members?.length ?? 0} 名成员
                    </p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {group.capabilities.map((capability) => (
                        <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
                      ))}
                    </div>
                    {canManageGrants && <SubjectGrantSummary kind="groups" subjectId={group.id} />}
                  </div>
                </Link>
                <div className="flex shrink-0 flex-wrap justify-end gap-2">
                  {canManageGrants && (
                    <Button size="sm" variant="outline" onClick={() => setGrantGroup(group)}>授权</Button>
                  )}
                  {canManageGroups && (
                    <Button size="sm" variant="destructive" disabled={group.isSystem} onClick={() => setDeleteGroup(group)}>
                      <Trash2 className="h-4 w-4" />删除
                    </Button>
                  )}
                </div>
              </ResourceListRow>
            ))}
          </ResourceList>
        )}
      </QueryView>
      {canManageGroups && <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {grantGroup && (
        <Dialog open onOpenChange={(open) => { if (!open) setGrantGroup(null); }}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>管理「{grantGroup.name}」的授权</DialogTitle>
              <DialogDescription>按服务器 / 存储池 / 共享存储分别设置额度与到期时间。</DialogDescription>
            </DialogHeader>
            <CanonicalGrantPanel subject={grantGroup} kind="groups" />
            <DialogFooter>
              <Button variant="outline" onClick={() => setGrantGroup(null)}>完成</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
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
          <DialogDescription>创建后可在授权面板设置资源范围。</DialogDescription>
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
