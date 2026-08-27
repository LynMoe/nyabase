import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus, Shield, Trash2 } from 'lucide-react';
import { Capability, zCreateGroupRequest, type CreateGroupRequest, type GroupDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
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
  if (groupsQuery.isLoading) return <QueryLoadingState label="加载用户组..." />;
  if (groupsQuery.isError) return <QueryErrorState error={groupsQuery.error} resourceName="用户组" onRetry={() => { void groupsQuery.refetch(); }} />;
  const groups = groupsQuery.data ?? [];
  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="groups-management">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">用户组</h1>
          <p className="text-sm text-muted-foreground">{groups.length} 个用户组 · 授权按资源范围管理</p>
        </div>
        {canManageGroups && (
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户组</Button>
        )}
      </div>
      {groups.length === 0 ? (
        <Card>
          <CardContent className="space-y-3 py-12 text-center">
            <p className="text-sm text-muted-foreground">暂无用户组。</p>
            {canManageGroups && (
              <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建用户组</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <Card key={group.id}>
              <CardContent className="flex flex-wrap items-center justify-between gap-4 p-4">
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
                <div className="flex gap-2">
                  {canManageGrants && (
                    <Button size="sm" variant="outline" onClick={() => setGrantGroup(group)}>授权</Button>
                  )}
                  {canManageGroups && (
                    <Button size="sm" variant="destructive" disabled={group.isSystem} onClick={() => setDeleteGroup(group)}>
                      <Trash2 className="h-4 w-4" />删除
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      {canManageGroups && <CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} />}
      {grantGroup && (
        <Dialog open onOpenChange={(open) => { if (!open) setGrantGroup(null); }}>
          <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>管理 {grantGroup.name} 的授权</DialogTitle>
              <DialogDescription>按服务器 / 存储池 / 共享存储分别设置额度与到期时间。</DialogDescription>
            </DialogHeader>
            <CanonicalGrantPanel subject={grantGroup} kind="groups" />
          </DialogContent>
        </Dialog>
      )}
      <Dialog open={Boolean(deleteGroup)} onOpenChange={(open) => { if (!open) setDeleteGroup(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除用户组？</DialogTitle>
            <DialogDescription>
              系统组不可删除。删除后成员关系与资源授权会一并清理，且不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteGroup(null)}>取消</Button>
            <Button
              variant="destructive"
              onClick={() => { if (deleteGroup) remove.mutate(deleteGroup.id); }}
              disabled={remove.isPending}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
          <div className="space-y-1.5">
            <Label htmlFor="new-group-name">名称</Label>
            <Input id="new-group-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-group-description">描述</Label>
            <Input id="new-group-description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
