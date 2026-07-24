import { Link, getRouteApi } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, bootstrapAuthSession } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Badge } from '../components/ui/badge.js';
import { toast } from '../hooks/use-toast.js';
import { ArrowLeft, Trash2, Plus } from 'lucide-react';
import { Capability, GpuGrantMode } from '@nyabase/common';
import type {
  GroupAdministrationAvailabilityDto,
  GroupDto,
  GroupMemberDto,
  ServerGrantDto,
  ImageGrantDto,
} from '@nyabase/common';
import { formatBytes, formatCpu, resourceVal } from '../lib/utils.js';
import {
  ResourceGrantForm, ResourceFormValue, EMPTY_RESOURCE_FORM,
  grantToForm, formToGrantPayload,
} from '../components/resource-grant-form.js';
import { MountSourceGrantsPanel } from '../components/grants/mount-source-grants-panel.js';
import { useRequesterAgentTaskBatchFeedback } from '../hooks/use-agent-task-tracker.js';
import { useAuthStore } from '../store/auth.js';
import { ApiError } from '../lib/api.js';
import {
  adminCatalogPaths,
  type AdminCatalogGroup,
  type AdminCatalogUser,
  type GrantImageCatalogItem,
  type GrantServerCatalogItem,
} from '../lib/admin-catalog.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { imageGrantAction } from '../lib/image-grant-action.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  notifyAccessChangedForSubject,
  notifyGroupMembershipChangedForUser,
} from '../lib/auth-session.js';
import { useAdministrationActions } from '../hooks/use-administration-actions.js';
import { addTrackedTaskIds, retireTrackedTaskIds as retireTaskIds } from '../lib/tracked-task-ids.js';
import { groupMemberActionAvailability } from '../lib/group-member-action.js';

type TaskIdsResponse = { taskIds?: string[] };

const routeApi = getRouteApi('/groups/$id');

export default function GroupDetailPage() {
  const { id } = routeApi.useParams();
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageGroups = capabilities.includes(Capability.ManageGroups);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  type Tab = 'members' | 'server-grants' | 'image-grants' | 'mount-source-grants';
  const tabs: Tab[] = [
    ...(canManageGroups ? ['members' as const] : []),
    ...(canManageGrants ? ['server-grants' as const, 'image-grants' as const, 'mount-source-grants' as const] : []),
  ];
  const [activeTab, setActiveTab] = useState<Tab>(() => canManageGroups ? 'members' : 'server-grants');
  const [trackedTaskIds, setTrackedTaskIds] = useState<string[]>([]);
  const retireTrackedTaskIds = useCallback((settledIds: readonly string[]) => {
    setTrackedTaskIds((current) => retireTaskIds(current, settledIds));
  }, []);
  useRequesterAgentTaskBatchFeedback(trackedTaskIds, {
    invalidateQueryKeys: [
      queryKeys.groups.admin,
      queryKeys.users.admin,
      queryKeys.dataDirs.allUser,
    ],
    onSettledTaskIds: retireTrackedTaskIds,
  });
  useEffect(() => {
    if (!tabs.includes(activeTab) && tabs[0]) setActiveTab(tabs[0]);
  }, [activeTab, tabs]);
  const trackTaskIds = (taskIds?: string[]) => {
    if (!taskIds?.length) return;
    setTrackedTaskIds((current) => addTrackedTaskIds(current, taskIds));
  };

  const groupQuery = useQuery<GroupDto | AdminCatalogGroup>({
    queryKey: ['group', canManageGroups ? 'admin' : 'grant-catalog', id],
    queryFn: async () => {
      if (canManageGroups) return api.get<GroupDto>(`/admin/groups/${id}`);
      const groups = await api.get<AdminCatalogGroup[]>(adminCatalogPaths.groups);
      const group = groups.find((candidate) => candidate.id === id);
      if (!group) throw new ApiError(404, 'GROUP_NOT_FOUND', '用户组不存在');
      return group;
    },
  });
  const administrationQuery = useAdministrationActions(canManageGroups);

  if (groupQuery.isLoading || (canManageGroups && administrationQuery.isLoading)) {
    return <QueryLoadingState label="加载用户组..." />;
  }
  if (groupQuery.isError) return (
    <QueryErrorState
      error={groupQuery.error}
      resourceName="用户组"
      onRetry={() => { void groupQuery.refetch(); }}
      onBack={() => window.history.back()}
    />
  );
  if (canManageGroups && administrationQuery.isError) return (
    <QueryErrorState
      error={administrationQuery.error}
      resourceName="用户组操作权限"
      onRetry={() => { void administrationQuery.refetch(); }}
      onBack={() => window.history.back()}
    />
  );
  const group = groupQuery.data;
  if (!group) return null;
  const memberAvailability = administrationQuery.data?.groups[id];

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex items-center gap-3">
        <Link to="/groups">
          <Button variant="outline" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{group.name}</h1>
          <p className="text-sm text-muted-foreground">
            {'priority' in group ? `优先级 ${group.priority} · ` : ''}{group.isSystem ? '系统组' : '自定义组'}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        {tabs.map((tab) => (
          <button key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${
              activeTab === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}>
            {tab === 'members' ? '成员' : tab === 'server-grants' ? '服务器授权' : tab === 'image-grants' ? '镜像授权' : '数据源授权'}
          </button>
        ))}
      </div>

      {canManageGroups && activeTab === 'members' && (
        <GroupMembersTab
          groupId={id}
          availability={memberAvailability}
          onTaskIds={trackTaskIds}
        />
      )}
      {canManageGrants && activeTab === 'server-grants' && <GroupServerGrantsTab groupId={id} onTaskIds={trackTaskIds} />}
      {canManageGrants && activeTab === 'image-grants' && <GroupImageGrantsTab groupId={id} />}
      {canManageGrants && activeTab === 'mount-source-grants' && (
        <MountSourceGrantsPanel
          subject={{ type: 'group', id }}
          description="选择该用户组可以访问哪些数据源（仍需同时拥有对应服务器的访问权限）"
        />
      )}
    </div>
  );
}

function GroupMembersTab({
  groupId,
  availability,
  onTaskIds,
}: {
  groupId: string;
  availability?: GroupAdministrationAvailabilityDto;
  onTaskIds: (taskIds?: string[]) => void;
}) {
  const qc = useQueryClient();
  const [selectedUserId, setSelectedUserId] = useState('');

  const membersQuery = useQuery({
    queryKey: ['group-members', groupId],
    queryFn: () => api.get<GroupMemberDto[]>(`/admin/groups/${groupId}/members`),
  });
  const usersQuery = useQuery({
    queryKey: ['admin-catalog', 'users'],
    queryFn: () => api.get<AdminCatalogUser[]>(adminCatalogPaths.users),
  });
  const members = membersQuery.data ?? [];
  const allUsers = usersQuery.data ?? [];

  const memberIds = new Set(members.map((m) => m.userId));
  const nonMembers = allUsers.filter((u) => !memberIds.has(u.id));

  const addMember = useMutation({
    mutationFn: (userId: string) => api.post<TaskIdsResponse>(`/admin/groups/${groupId}/members`, { userId }),
    onSuccess: (result, userId) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: ['group-members', groupId] });
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'administration-actions'] });
      notifyGroupMembershipChangedForUser(userId, groupId, true);
      void bootstrapAuthSession();
      toast({ title: '成员已添加' });
      setSelectedUserId('');
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete<TaskIdsResponse>(`/admin/groups/${groupId}/members/${userId}`),
    onSuccess: (result, userId) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: ['group-members', groupId] });
      qc.invalidateQueries({ queryKey: ['admin-catalog', 'administration-actions'] });
      notifyGroupMembershipChangedForUser(userId, groupId, false);
      void bootstrapAuthSession();
      toast({ title: '成员已移出' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  if (membersQuery.isLoading || usersQuery.isLoading) return <QueryLoadingState label="加载用户组成员..." />;
  const queryError = membersQuery.error ?? usersQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="用户组成员"
      onRetry={() => { void Promise.all([membersQuery.refetch(), usersQuery.refetch()]); }}
    />
  );

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {members.length === 0 && (
          <div className="text-sm text-muted-foreground py-6 text-center border border-dashed border-border rounded-lg">暂无成员</div>
        )}
        {members.map((m) => {
          const removeAvailability = groupMemberActionAvailability(availability, m.userId, true);
          return (
          <div key={m.userId} className="flex items-center justify-between py-2.5 px-4 rounded-lg border border-border bg-background">
            <div>
              <span className="font-mono text-sm font-medium text-foreground">{m.username}</span>
              {m.displayName && <span className="text-sm text-muted-foreground ml-2">{m.displayName}</span>}
            </div>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
              disabled={removeMember.isPending || !removeAvailability?.allowed}
              title={removeAvailability?.reason ?? undefined}
              onClick={() => removeMember.mutate(m.userId)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
          );
        })}
      </div>

      {nonMembers.length > 0 && (
        <div className="flex gap-2 pt-2 border-t border-border">
          <select
            disabled={!availability?.canManageMembers.allowed}
            title={availability?.canManageMembers.reason ?? undefined}
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
          className="flex-1 text-sm border border-border rounded-lg px-3 py-1.5 bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
            <option value="">选择用户添加...</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{u.username}{u.displayName ? ` (${u.displayName})` : ''}</option>
            ))}
          </select>
          <Button size="sm" className="shrink-0" disabled={!selectedUserId || addMember.isPending || !availability?.canManageMembers.allowed}
            title={availability?.canManageMembers.reason ?? undefined}
            onClick={() => selectedUserId && addMember.mutate(selectedUserId)}>
            <Plus className="h-4 w-4" />添加
          </Button>
        </div>
      )}
      {!availability?.canManageMembers.allowed && availability?.canManageMembers.reason && (
        <p className="text-xs text-amber-600">当前账号不能添加该组成员：{availability.canManageMembers.reason}</p>
      )}
    </div>
  );
}

function GroupServerGrantsTab({
  groupId,
  onTaskIds,
}: {
  groupId: string;
  onTaskIds: (taskIds?: string[]) => void;
}) {
  const qc = useQueryClient();
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [form, setForm] = useState<ResourceFormValue>(EMPTY_RESOURCE_FORM);

  const serversQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get<GrantServerCatalogItem[]>(adminCatalogPaths.grantServers),
  });
  const grantsQuery = useQuery({
    queryKey: ['group-server-grants', groupId],
    queryFn: () => api.get<ServerGrantDto[]>(`/admin/groups/${groupId}/server-grants`),
  });

  const servers = serversQuery.data ?? [];
  const grants = grantsQuery.data ?? [];

  const getGrant = (sid: string) => grants.find((g) => g.serverId === sid);

  const upsert = useMutation({
    mutationFn: (serverId: string) => {
      const server = servers.find((candidate) => candidate.id === serverId);
      if (!server) throw new Error('服务器目录已变化，请刷新后重试');
      return api.post<ServerGrantDto & TaskIdsResponse>(
        `/admin/groups/${groupId}/server-grants/${serverId}`,
        formToGrantPayload(form, { availableGpuIndices: server.gpus.map((gpu) => gpu.index) }),
      );
    },
    onSuccess: (result) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: ['group-server-grants', groupId] });
      notifyAccessChangedForSubject({ type: 'group', id: groupId });
      toast({ title: '授权已更新' });
      setEditingServerId(null);
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const remove = useMutation({
    mutationFn: (serverId: string) => api.delete<TaskIdsResponse>(`/admin/groups/${groupId}/server-grants/${serverId}`),
    onSuccess: (result) => {
      onTaskIds(result.taskIds);
      qc.invalidateQueries({ queryKey: ['group-server-grants', groupId] });
      notifyAccessChangedForSubject({ type: 'group', id: groupId });
      toast({ title: '授权已移除' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const startEdit = (serverId: string) => {
    const g = getGrant(serverId);
    setForm(g ? grantToForm(g) : EMPTY_RESOURCE_FORM);
    setEditingServerId(serverId);
  };

  if (serversQuery.isLoading || grantsQuery.isLoading) return <QueryLoadingState label="加载服务器授权..." />;
  const queryError = serversQuery.error ?? grantsQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="服务器授权"
      onRetry={() => { void Promise.all([serversQuery.refetch(), grantsQuery.refetch()]); }}
    />
  );

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">空字段使用服务器的默认值（在服务器详情页设置）</p>
      {servers.map((s) => {
        const g = getGrant(s.id);
        if (editingServerId === s.id) {
          return (
            <div key={s.id} className="border rounded-lg p-4 space-y-3 bg-background">
              <div className="font-medium text-sm text-foreground">{s.name}</div>
              <ResourceGrantForm
                value={form}
                onChange={setForm}
                emptyHint="（空=不限）"
                showGpu={(s.gpus?.length ?? 0) > 0}
              />
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="outline" onClick={() => setEditingServerId(null)}>取消</Button>
                <Button size="sm" disabled={upsert.isPending} onClick={() => upsert.mutate(s.id)}>
                  {upsert.isPending ? '保存中...' : '保存'}
                </Button>
              </div>
            </div>
          );
        }

        return (
          <div key={s.id} className="flex items-center justify-between py-3 px-4 rounded-lg border border-border bg-background">
            <div>
              <span className="font-medium text-foreground">{s.name}</span>
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${s.status === 'online' ? 'bg-green-50 text-green-700' : 'bg-muted text-muted-foreground'}`}>
                {s.status === 'online' ? '在线' : '离线'}
              </span>
              {g ? (
                <div className="text-xs mt-1 space-x-3">
                  <span className="text-muted-foreground">
                    {resourceVal(g.cpuMillis, formatCpu)} CPU
                  </span>
                  <span className="text-muted-foreground">
                    {resourceVal(g.memBytes, formatBytes)} 内存
                  </span>
                  <span className="text-muted-foreground">
                    {resourceVal(g.diskBytes, formatBytes)} 磁盘
                  </span>
                  {(s.gpus?.length ?? 0) > 0 && (
                    <span className="text-muted-foreground">
                      GPU: {g.gpuMode ?? 'all'}{g.gpuMode === GpuGrantMode.Indices ? ` [${g.gpuIndices?.join(',')}]` : ''}
                    </span>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground/50 mt-1">无授权</div>
              )}
            </div>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => startEdit(s.id)}>
                {g ? '编辑' : <><Plus className="h-4 w-4" />授权</>}
              </Button>
              {g && (
                <Button size="icon" variant="ghost" disabled={remove.isPending} className="h-8 w-8 text-red-400 hover:text-red-600"
                  onClick={() => remove.mutate(s.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GroupImageGrantsTab({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(() => new Set());

  const imagesQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-images'],
    queryFn: () => api.get<GrantImageCatalogItem[]>(adminCatalogPaths.grantImages),
  });
  const serversQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get<GrantServerCatalogItem[]>(adminCatalogPaths.grantServers),
  });
  const grantsQuery = useQuery({
    queryKey: ['group-image-grants', groupId],
    queryFn: () => api.get<ImageGrantDto[]>(`/admin/groups/${groupId}/image-grants`),
  });

  const images = imagesQuery.data ?? [];
  const servers = serversQuery.data ?? [];
  const grants = grantsQuery.data ?? [];

  const toggleGrant = useMutation({
    mutationFn: ({ imageId, serverId, granted }: { imageId: string; serverId: string; granted: boolean }) => {
      const action = imageGrantAction({ type: 'group', id: groupId }, imageId, serverId, granted);
      return action.method === 'DELETE' ? api.delete(action.path) : api.post(action.path, action.body);
    },
    onMutate: ({ imageId, serverId }) => {
      const key = `${imageId}:${serverId}`;
      setPendingKeys((current) => new Set(current).add(key));
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['group-image-grants', groupId] });
      notifyAccessChangedForSubject({ type: 'group', id: groupId });
      toast({ title: '镜像授权已更新' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
    onSettled: (_data, _error, { imageId, serverId }) => {
      const key = `${imageId}:${serverId}`;
      setPendingKeys((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
  });

  const removeOrphan = useMutation({
    mutationFn: (imageId: string) => Promise.all(
      grants
        .filter((grant) => grant.imageId === imageId)
        .map((grant) => api.delete(`/admin/groups/${groupId}/image-grants/${imageId}/${grant.serverId}`)),
    ),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['group-image-grants', groupId] });
      notifyAccessChangedForSubject({ type: 'group', id: groupId });
      toast({ title: '残留授权已移除' });
    },
    onError: (e) => toast({ title: '失败', description: e.message, variant: 'destructive' }),
  });

  const getGrantedServers = (imageId: string) =>
    new Set(grants.filter((g) => g.imageId === imageId).map((g) => g.serverId));

  const imageIds = new Set(images.map((img) => img.id));
  const orphanedImageIds = [...new Set(grants.filter((g) => !imageIds.has(g.imageId)).map((g) => g.imageId))];

  const serverMap = new Map(servers.map((s) => [s.id, s]));

  if (imagesQuery.isLoading || serversQuery.isLoading || grantsQuery.isLoading) {
    return <QueryLoadingState label="加载镜像授权..." />;
  }
  const queryError = imagesQuery.error ?? serversQuery.error ?? grantsQuery.error;
  if (queryError) return (
    <QueryErrorState
      error={queryError}
      resourceName="镜像授权"
      onRetry={() => { void Promise.all([imagesQuery.refetch(), serversQuery.refetch(), grantsQuery.refetch()]); }}
    />
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">选择每个镜像可在哪些服务器上使用</p>
      {images.map((img) => {
        const grantedServerIds = getGrantedServers(img.id);
        return (
          <div key={img.id} className="bg-background rounded-lg border border-border p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-medium text-foreground">{img.name}</span>
                {img.description && <span className="text-xs text-muted-foreground ml-2">{img.description}</span>}
              </div>
              {!img.isActive && <Badge variant="outline" className="text-xs">已停用</Badge>}
            </div>
            <div className="flex flex-wrap gap-2">
              {servers.map((s) => {
                const granted = grantedServerIds.has(s.id);
                const key = `${img.id}:${s.id}`;
                return (
                  <button key={s.id}
                    onClick={() => toggleGrant.mutate({ imageId: img.id, serverId: s.id, granted })}
                    disabled={pendingKeys.has(key)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      granted
                        ? 'bg-primary/10 border-primary/30 text-primary hover:bg-primary/20'
                        : 'bg-muted border-border text-muted-foreground hover:bg-muted/80'
                    }`}>
                    {pendingKeys.has(key) ? '处理中...' : s.name}
                  </button>
                );
              })}
              {servers.length === 0 && <span className="text-xs text-muted-foreground/50">暂无服务器</span>}
            </div>
          </div>
        );
      })}

      {orphanedImageIds.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-red-100">
          <p className="text-xs text-red-500">以下镜像已停用或删除，存在残留授权：</p>
          {orphanedImageIds.map((imageId) => {
            const grantedServers = grants
              .filter((g) => g.imageId === imageId)
              .map((g) => serverMap.get(g.serverId)?.name ?? g.serverId);
            return (
              <div key={imageId} className="flex items-center justify-between bg-red-50 border border-red-100 rounded-lg px-4 py-3">
                <div>
                  <span className="text-sm font-mono text-red-700">[不可用] {imageId.slice(0, 8)}…</span>
                  <div className="text-xs text-red-400 mt-0.5">{grantedServers.join('、')}</div>
                </div>
                <Button size="sm" variant="ghost" className="text-red-500 hover:text-red-700 hover:bg-red-100"
                  disabled={removeOrphan.isPending}
                  onClick={() => removeOrphan.mutate(imageId)}>
                  <Trash2 className="h-4 w-4" />移除
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
