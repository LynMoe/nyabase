import { Link } from '@tanstack/react-router';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, apiErrorCurrent, bootstrapAuthSession } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Badge } from '../components/ui/badge.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog.js';
import { toast } from '../hooks/use-toast.js';
import { Plus, Trash2, Settings2, ChevronRight, Image, Users, RefreshCw } from 'lucide-react';
import { Capability, GpuGrantMode } from '@nyabase/common';
import type {
  AdministrationActionsDto,
  GroupAdministrationAvailabilityDto,
  GroupDto,
  ServerGrantDto,
} from '@nyabase/common';
import { formatCpu, formatBytesCompact } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import { useRequesterAgentTaskBatchFeedback } from '../hooks/use-agent-task-tracker.js';
import { useAuthStore } from '../store/auth.js';
import {
  adminCatalogPaths,
  type AdminCatalogGroup,
  type GrantImageCatalogItem,
  type GrantServerCatalogItem,
} from '../lib/admin-catalog.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { MAX_GROUP_PRIORITY, parseGroupPriority } from '../lib/form-validation.js';
import { notifyAccessChangedForSubject } from '../lib/auth-session.js';
import { addTrackedTaskIds, retireTrackedTaskIds as retireTaskIds } from '../lib/tracked-task-ids.js';
import {
  createRevisionedServerBackedDraft,
  editRevisionedServerBackedDraft,
  mergeAuthoritativeRevisionedServerBackedDraft,
  mergeRevisionedServerBackedDraft,
  resolveRevisionedDraftConflicts,
  type RevisionedServerBackedDraft,
} from '../lib/server-backed-draft.js';
import {
  buildMinimalGroupEditPayload,
  type GroupEditFormState,
} from '../lib/group-edit-form.js';
import {
  acceptGroupAuthorityActions,
  acceptGroupAuthorityGroups,
  beginGroupAuthorityRefresh,
  changeGroupAuthorityContext,
  createGroupAuthorityRefreshState,
  groupAuthorityProjectionReady,
  rejectGroupAuthorityActions,
  rejectGroupAuthorityGroups,
} from '../lib/group-authority-refresh.js';
import { isGroupDto } from '../lib/conflict-snapshots.js';

type TaskIdsResponse = { taskIds?: string[] };

const CAP_LABELS: Record<string, string> = {
  [Capability.ManageUsers]: '管理用户',
  [Capability.ManageGroups]: '管理用户组',
  [Capability.ManageServers]: '管理服务器',
  [Capability.ManageImages]: '管理镜像',
  [Capability.ManageGrants]: '管理授权',
  [Capability.ManageContainersAny]: '管理所有容器',
  [Capability.ViewAudit]: '查看审计',
  [Capability.ViewMetricsAll]: '查看全量监控',
  [Capability.ManageSystemSettings]: '管理系统设置',
};

const MEMBER_LIMIT = 30;
const IMAGE_CHIP_LIMIT = 5;
let nextAuthorityQueryScope = 1;

function isFullGroup(group: GroupDto | AdminCatalogGroup): group is GroupDto {
  return 'members' in group;
}

function gpuLabel(grant: ServerGrantDto): string {
  if (grant.gpuMode === null) return '显卡默认';
  if (grant.gpuMode === GpuGrantMode.None) return '无显卡';
  if (grant.gpuMode === GpuGrantMode.All) return '显卡全部';
  if (grant.gpuMode === GpuGrantMode.Indices) return `显卡[${(grant.gpuIndices ?? []).join(',')}]`;
  return '';
}

function ServerGrantChips({
  grants,
  serverMap,
}: {
  grants: ServerGrantDto[];
  serverMap: Map<string, string>;
}) {
  if (grants.length === 0) return <span className="text-xs text-muted-foreground/70">无服务器授权</span>;
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {grants.map((g) => {
        const cpu = g.cpuMillis === null ? '不限' : formatCpu(g.cpuMillis);
        const mem = g.memBytes === null ? '不限' : formatBytesCompact(g.memBytes);
        const gpu = gpuLabel(g);
        const serverName = serverMap.get(g.serverId) ?? g.serverId.slice(0, 8);
        return (
          <div key={g.id} className="inline-flex flex-col px-2.5 py-1.5 rounded-lg bg-primary/10 border border-primary/30 text-primary min-w-0">
            <span className="text-xs font-medium leading-tight">{serverName}</span>
            <span className="text-[10px] text-primary/80 leading-tight mt-0.5 whitespace-nowrap">
              CPU {cpu} · 内存 {mem} · {gpu}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function GroupsPage() {
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const authorityPrincipalId = useAuthStore((state) => state.user?.id ?? 'anonymous');
  const canManageGroups = capabilities.includes(Capability.ManageGroups);
  const canManageGrants = capabilities.includes(Capability.ManageGrants);
  const [showCreate, setShowCreate] = useState(false);
  const [editGroup, setEditGroup] = useState<GroupDto | null>(null);
  const [authorityQueryScope] = useState(() => nextAuthorityQueryScope++);
  const authorityContext = `${authorityPrincipalId}:${[...capabilities].sort().join(',')}`;
  const authorityContextRef = useRef(authorityContext);
  authorityContextRef.current = authorityContext;
  const [authorityRefresh, setAuthorityRefresh] = useState(
    () => createGroupAuthorityRefreshState(authorityContext),
  );
  const authorityRefreshRef = useRef(authorityRefresh);
  authorityRefreshRef.current = authorityRefresh;
  const [adminGroupsSnapshot, setAdminGroupsSnapshot] = useState<{
    context: string;
    generation: number;
    data: GroupDto[];
  } | null>(null);
  const [administrationSnapshot, setAdministrationSnapshot] = useState<{
    context: string;
    generation: number;
    data: AdministrationActionsDto;
  } | null>(null);
  const startAuthorityRefresh = useCallback(() => {
    const next = beginGroupAuthorityRefresh(
      changeGroupAuthorityContext(authorityRefreshRef.current, authorityContext),
    );
    authorityRefreshRef.current = next;
    setAuthorityRefresh(next);
  }, [authorityContext]);
  useEffect(() => {
    const next = changeGroupAuthorityContext(authorityRefreshRef.current, authorityContext);
    authorityRefreshRef.current = next;
    setAuthorityRefresh(next);
  }, [authorityContext]);
  useEffect(() => {
    if (!canManageGroups) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') startAuthorityRefresh();
    };
    window.addEventListener('online', startAuthorityRefresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('online', startAuthorityRefresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [canManageGroups, startAuthorityRefresh]);
  const [trackedTaskIds, setTrackedTaskIds] = useState<string[]>([]);
  const retireTrackedTaskIds = useCallback((settledIds: readonly string[]) => {
    setTrackedTaskIds((current) => retireTaskIds(current, settledIds));
  }, []);
  useRequesterAgentTaskBatchFeedback(trackedTaskIds, {
    invalidateQueryKeys: [
      queryKeys.users.admin,
      queryKeys.dataDirs.allUser,
    ],
    onSettledTaskIds: (settledIds) => {
      retireTrackedTaskIds(settledIds);
      startAuthorityRefresh();
    },
  });
  const trackTaskIds = (taskIds?: string[]) => {
    if (!taskIds?.length) return;
    setTrackedTaskIds((current) => addTrackedTaskIds(current, taskIds));
  };

  const authorityGeneration = authorityRefresh.generation;
  const authorityPairQueryKey = [
    'group-authority-pair',
    authorityQueryScope,
    authorityContext,
    authorityGeneration,
  ] as const;
  const adminGroupsQuery = useQuery({
    queryKey: [...authorityPairQueryKey, 'groups'] as const,
    queryFn: async () => {
      try {
        const groups = await api.get<GroupDto[]>('/admin/groups');
        const current = authorityRefreshRef.current;
        if (authorityContextRef.current === authorityContext
          && current.context === authorityContext
          && current.generation === authorityGeneration) {
          const next = acceptGroupAuthorityGroups(current, authorityContext, authorityGeneration);
          authorityRefreshRef.current = next;
          setAdminGroupsSnapshot({ context: authorityContext, generation: authorityGeneration, data: groups });
          setAuthorityRefresh(next);
        }
        return groups;
      } catch (error) {
        const current = authorityRefreshRef.current;
        if (authorityContextRef.current === authorityContext
          && current.context === authorityContext
          && current.generation === authorityGeneration) {
          const next = rejectGroupAuthorityGroups(current, authorityContext, authorityGeneration);
          authorityRefreshRef.current = next;
          setAuthorityRefresh(next);
        }
        throw error;
      }
    },
    enabled: canManageGroups,
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const catalogGroupsQuery = useQuery({
    queryKey: ['groups', 'catalog'] as const,
    queryFn: () => api.get<AdminCatalogGroup[]>(adminCatalogPaths.groups),
    enabled: !canManageGroups,
  });
  const groupsQuery = canManageGroups ? adminGroupsQuery : catalogGroupsQuery;
  const administrationQuery = useQuery({
    queryKey: [...authorityPairQueryKey, 'administration-actions'] as const,
    queryFn: async () => {
      try {
        const actions = await api.get<AdministrationActionsDto>(adminCatalogPaths.administrationActions);
        const current = authorityRefreshRef.current;
        if (authorityContextRef.current === authorityContext
          && current.context === authorityContext
          && current.generation === authorityGeneration) {
          const next = acceptGroupAuthorityActions(current, authorityContext, authorityGeneration);
          if (next !== current) {
            authorityRefreshRef.current = next;
            setAdministrationSnapshot({ context: authorityContext, generation: authorityGeneration, data: actions });
            setAuthorityRefresh(next);
          }
        }
        return actions;
      } catch (error) {
        const current = authorityRefreshRef.current;
        if (authorityContextRef.current === authorityContext
          && current.context === authorityContext
          && current.generation === authorityGeneration) {
          const next = rejectGroupAuthorityActions(current, authorityContext, authorityGeneration);
          if (next !== current) {
            authorityRefreshRef.current = next;
            setAuthorityRefresh(next);
          }
        }
        throw error;
      }
    },
    enabled: canManageGroups
      && authorityRefresh.context === authorityContext
      && authorityRefresh.groups === 'succeeded',
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const serversQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-servers'],
    queryFn: () => api.get<GrantServerCatalogItem[]>(adminCatalogPaths.grantServers),
    enabled: canManageGrants,
  });
  const imagesQuery = useQuery({
    queryKey: ['admin-catalog', 'grant-images'],
    queryFn: () => api.get<GrantImageCatalogItem[]>(adminCatalogPaths.grantImages),
    enabled: canManageGrants,
  });

  const displayedAdminGroups = adminGroupsSnapshot?.context === authorityContext
    ? adminGroupsSnapshot.data
    : undefined;
  const displayedAdministration = administrationSnapshot?.context === authorityContext
    ? administrationSnapshot.data
    : undefined;
  const acceptedAdministration = administrationSnapshot?.context === authorityContext
    && administrationSnapshot.generation === authorityRefresh.generation
    ? administrationSnapshot.data
    : undefined;
  const groups = canManageGroups ? (displayedAdminGroups ?? []) : (catalogGroupsQuery.data ?? []);
  const serverEditGroup = editGroup && displayedAdminGroups
    ? displayedAdminGroups.find((candidate) => candidate.id === editGroup.id) ?? null
    : editGroup;
  const servers = serversQuery.data ?? [];
  const images = imagesQuery.data ?? [];
  const authoritySnapshotPending = canManageGroups && (
    authorityRefresh.context !== authorityContext
    || !groupAuthorityProjectionReady(authorityRefresh)
  );
  const groupsFetching = groupsQuery.isFetching || (canManageGroups && authoritySnapshotPending);

  const serverMap = new Map(servers.map((s) => [s.id, s.name]));
  const imageMap = new Map(images.map((img) => [img.id, img.name]));

  const deleteGroup = useMutation({
    mutationFn: (id: string) => {
      if (authoritySnapshotPending) throw new Error('正在刷新用户组操作权限，请稍后重试');
      return api.delete<TaskIdsResponse>(`/admin/groups/${id}`);
    },
    onSuccess: (result, groupId) => {
      trackTaskIds(result.taskIds);
      startAuthorityRefresh();
      notifyAccessChangedForSubject({ type: 'group', id: groupId });
      void bootstrapAuthSession();
      toast({ title: '用户组已删除' });
    },
    onError: (e) => toast({ title: '删除失败', description: e.message, variant: 'destructive' }),
  });

  if ((canManageGroups ? (!displayedAdminGroups && adminGroupsQuery.isLoading) : catalogGroupsQuery.isLoading)
    || (canManageGroups && !displayedAdministration && administrationQuery.isLoading)
    || (canManageGrants && (serversQuery.isLoading || imagesQuery.isLoading))) {
    return <QueryLoadingState label="加载用户组..." />;
  }
  if (groupsQuery.isError && (!canManageGroups || !displayedAdminGroups)) return (
    <QueryErrorState
      error={groupsQuery.error}
      resourceName="用户组"
      onRetry={startAuthorityRefresh}
    />
  );
  if (canManageGroups && administrationQuery.isError && !displayedAdministration) return (
    <QueryErrorState
      error={administrationQuery.error}
      resourceName="用户组操作权限"
      onRetry={startAuthorityRefresh}
    />
  );
  const catalogError = canManageGrants ? (serversQuery.error ?? imagesQuery.error) : null;
  if (catalogError) return (
    <QueryErrorState
      error={catalogError}
      resourceName="授权目录"
      onRetry={() => { void Promise.all([serversQuery.refetch(), imagesQuery.refetch()]); }}
    />
  );
  const authorityRefreshError = canManageGroups
    ? (adminGroupsQuery.error ?? administrationQuery.error)
    : null;

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">用户组管理</h1>
          <p className="text-sm text-muted-foreground mt-0.5">通过用户组统一分配服务器/镜像权限</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => {
            if (canManageGroups) startAuthorityRefresh();
            else void groupsQuery.refetch();
          }} disabled={groupsFetching}>
            <RefreshCw className={`h-4 w-4 ${groupsFetching ? 'animate-spin' : ''}`} />
          </Button>
          {canManageGroups && (
            <Button
              onClick={() => setShowCreate(true)}
              disabled={authoritySnapshotPending || !acceptedAdministration?.createGroup.allowed}
              title={acceptedAdministration?.createGroup.reason ?? undefined}
            >
              <Plus className="h-4 w-4" />新建用户组
            </Button>
          )}
        </div>
      </div>

      {authorityRefreshError && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>刷新用户组与操作权限失败；编辑内容已保留，所有管理操作保持禁用。</span>
          <Button size="sm" variant="outline" onClick={startAuthorityRefresh}>重试</Button>
        </div>
      )}

      <div className="space-y-3">
        {groups.map((g) => {
          const administration = acceptedAdministration?.groups[g.id];
          const fullGroup = isFullGroup(g) ? g : null;
          const members = fullGroup?.members ?? [];
          const visibleMembers = members.slice(0, MEMBER_LIMIT);
          const extraMembers = members.length - MEMBER_LIMIT;
          const grantsProjected = Boolean(fullGroup
            && Array.isArray(fullGroup.serverGrants)
            && Array.isArray(fullGroup.imageIds));
          const imageIds = grantsProjected ? (fullGroup?.imageIds ?? []) : [];
          const visibleImageIds = imageIds.slice(0, IMAGE_CHIP_LIMIT);
          const extraImages = imageIds.length - IMAGE_CHIP_LIMIT;

          return (
            <div key={g.id} className="bg-card rounded-lg border border-border p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0 space-y-2.5">
                  {/* Header row */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-foreground">{g.name}</span>
                    {g.isSystem && <Badge variant="outline" className="text-xs">系统组</Badge>}
                    {fullGroup && <span className="text-xs text-muted-foreground/70">优先级 {fullGroup.priority}</span>}
                  </div>

                  {fullGroup?.description && <p className="text-sm text-muted-foreground">{fullGroup.description}</p>}

                  {/* Capability badges */}
                  {fullGroup && fullGroup.capabilities.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {fullGroup.capabilities.map((cap) => (
                        <Badge key={cap} variant="secondary" className="text-xs">
                          {CAP_LABELS[cap] ?? cap}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Members */}
                  {canManageGroups && <div className="pt-1.5 border-t border-border">
                    <div className="flex items-center gap-1 mb-1.5">
                      <Users className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                      <span className="text-xs text-muted-foreground/70">成员 {members.length}</span>
                    </div>
                    {members.length === 0 ? (
                      <span className="text-xs text-muted-foreground/70">暂无成员</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {visibleMembers.map((m) => (
                          <span key={m.userId}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted text-foreground/90">
                            {m.username}
                          </span>
                        ))}
                        {extraMembers > 0 && (
                          <Link to="/groups/$id" params={{ id: g.id }}>
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-muted/50 text-muted-foreground/70 border border-border hover:bg-muted cursor-pointer">
                              +{extraMembers} 更多
                            </span>
                          </Link>
                        )}
                      </div>
                    )}
                  </div>}

                  {/* Server grants with resource details */}
                  {canManageGrants && fullGroup && grantsProjected && <div className="space-y-1">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-xs text-muted-foreground/70">服务器授权</span>
                    </div>
                    <ServerGrantChips grants={fullGroup.serverGrants ?? []} serverMap={serverMap} />
                  </div>}

                  {/* Image grants */}
                  {canManageGrants && fullGroup && grantsProjected && <div className="space-y-1">
                    <div className="flex items-center gap-1 mb-1">
                      <Image className="h-3 w-3 text-muted-foreground/70 shrink-0" />
                      <span className="text-xs text-muted-foreground/70">镜像授权</span>
                    </div>
                    {imageIds.length === 0 ? (
                      <span className="text-xs text-muted-foreground/70">无镜像授权</span>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1">
                        {visibleImageIds.map((id) => (
                          <span key={id}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-violet-50 text-violet-700 border border-violet-100">
                            {imageMap.get(id) ?? id.slice(0, 8)}
                          </span>
                        ))}
                        {extraImages > 0 && (
                          <span className="text-xs text-muted-foreground/70">+{extraImages}</span>
                        )}
                      </div>
                    )}
                  </div>}
                  {canManageGrants && fullGroup && !grantsProjected && (
                    <p className="text-xs text-muted-foreground">授权摘要未加载，请进入「授权」查看真实记录。</p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {canManageGroups && fullGroup && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={authoritySnapshotPending || !administration?.canEditMetadata.allowed}
                      title={administration?.canEditMetadata.reason ?? undefined}
                      onClick={() => setEditGroup(fullGroup)}
                    >
                      <Settings2 className="h-4 w-4" />编辑
                    </Button>
                  )}
                  <Link to="/groups/$id" params={{ id: g.id }}>
                    <Button size="sm" variant="outline">
                      {canManageGrants ? '授权' : '成员'} <ChevronRight className="h-4 w-4" />
                    </Button>
                  </Link>
                  {canManageGroups && !g.isSystem && (
                    <Button size="icon" variant="ghost" className="h-8 w-8 text-red-400 hover:text-red-600"
                      disabled={authoritySnapshotPending || !administration?.canDelete.allowed || deleteGroup.isPending}
                      title={administration?.canDelete.reason ?? undefined}
                      onClick={() => { if (confirm(`删除用户组 "${g.name}"？`)) deleteGroup.mutate(g.id); }}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {canManageGroups && showCreate
        && (authoritySnapshotPending || acceptedAdministration?.createGroup.allowed) && (
        <CreateGroupDialog
          open
          assignableCapabilities={acceptedAdministration?.assignableGroupCapabilities ?? []}
          authorityPending={authoritySnapshotPending}
          onOpenChange={setShowCreate}
          onAuthorityChanged={startAuthorityRefresh}
        />
      )}
      {editGroup && (
        <EditGroupDialog
          group={editGroup}
          serverGroup={serverEditGroup}
          availability={acceptedAdministration?.groups[editGroup.id]}
          assignableCapabilities={acceptedAdministration?.assignableGroupCapabilities ?? []}
          authorityPending={authoritySnapshotPending}
          onClose={() => setEditGroup(null)}
          onTaskIds={trackTaskIds}
          onAuthorityChanged={startAuthorityRefresh}
        />
      )}
    </div>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  assignableCapabilities,
  authorityPending,
  onAuthorityChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  assignableCapabilities: readonly Capability[];
  authorityPending: boolean;
  onAuthorityChanged: () => void;
}) {
  const [form, setForm] = useState({ name: '', description: '', priority: '10', capabilities: [] as Capability[] });

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      if (authorityPending) throw new Error('正在刷新用户组操作权限，请稍后重试');
      return api.post('/admin/groups', {
        name: form.name,
        description: form.description || undefined,
        priority: parseGroupPriority(form.priority, 10),
        capabilities: form.capabilities,
      });
    },
    onSuccess: () => {
      onAuthorityChanged();
      void bootstrapAuthSession();
      toast({ title: '用户组已创建' });
      onOpenChange(false);
      setForm({ name: '', description: '', priority: '10', capabilities: [] });
    },
    onError: (e) => toast({ title: '创建失败', description: e.message, variant: 'destructive' }),
  });

  const assignable = new Set(assignableCapabilities);
  const hasUnassignableCapabilities = form.capabilities.some((cap) => !assignable.has(cap));
  const toggleCap = (cap: Capability) => setForm((f) => {
    const selected = f.capabilities.includes(cap);
    if (!selected && !assignable.has(cap)) return f;
    return {
      ...f,
      capabilities: selected
        ? f.capabilities.filter((c) => c !== cap)
        : [...f.capabilities, cap],
    };
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>新建用户组</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">组名</Label>
              <Input value={form.name} disabled={authorityPending} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">优先级（越大越强）</Label>
              <Input type="number" min={0} max={MAX_GROUP_PRIORITY} step={1} value={form.priority} disabled={authorityPending} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">描述（可选）</Label>
            <Input value={form.description} disabled={authorityPending} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">管理权限</Label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(CAP_LABELS).map(([cap, label]) => (
                <label
                  key={cap}
                  className={`flex items-center gap-2 ${assignable.has(cap as Capability) || form.capabilities.includes(cap as Capability) ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
                  title={assignable.has(cap as Capability) || form.capabilities.includes(cap as Capability) ? undefined : '只能分配当前账号自身持有的权限'}
                >
                  <input type="checkbox" checked={form.capabilities.includes(cap as Capability)}
                    disabled={authorityPending || (!assignable.has(cap as Capability) && !form.capabilities.includes(cap as Capability))}
                    onChange={() => toggleCap(cap as Capability)} className="rounded" />
                  <span className="text-sm text-foreground/90">{label}</span>
                </label>
              ))}
            </div>
            {hasUnassignableCapabilities && (
              <p className="text-xs text-destructive">当前权限已变化，请取消不再可分配的权限后重试。</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => mutate()} disabled={authorityPending || isPending || !form.name || hasUnassignableCapabilities}>
            {isPending ? '创建中...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditGroupDialog({
  group,
  serverGroup,
  availability,
  assignableCapabilities,
  authorityPending,
  onClose,
  onTaskIds,
  onAuthorityChanged,
}: {
  group: GroupDto;
  serverGroup?: GroupDto | null;
  availability?: GroupAdministrationAvailabilityDto;
  assignableCapabilities: readonly Capability[];
  authorityPending: boolean;
  onClose: () => void;
  onTaskIds: (taskIds?: string[]) => void;
  onAuthorityChanged: () => void;
}) {
  const [draft, setDraft] = useState<RevisionedServerBackedDraft<GroupEditFormState>>(
    () => createRevisionedServerBackedDraft(groupEditForm(group), group.revision),
  );
  const serverGroupSignature = serverGroup ? groupEditSignature(serverGroup) : null;

  useEffect(() => {
    setDraft(createRevisionedServerBackedDraft(groupEditForm(group), group.revision));
  }, [group.id]);

  useEffect(() => {
    if (!serverGroup || serverGroup.id !== group.id) return;
    setDraft((current) => mergeRevisionedServerBackedDraft(
      current,
      groupEditForm(serverGroup),
      serverGroup.revision,
    ));
  }, [group.id, serverGroup?.id, serverGroup?.revision, serverGroupSignature]);

  const form = draft.values;
  const setField = <K extends keyof GroupEditFormState>(field: K, value: GroupEditFormState[K]) => {
    setDraft((current) => editRevisionedServerBackedDraft(current, field, value));
  };

  const authority = {
    isSystem: group.isSystem,
    canEditMetadata: !authorityPending && (availability?.canEditMetadata.allowed ?? false),
    canEditPriority: !authorityPending && (availability?.canEditPriority.allowed ?? false),
  };
  const payloadResult = buildMinimalGroupEditPayload(form, draft.dirtyFields, authority);
  const pendingServerMerge = serverGroup !== undefined && (
    serverGroup === null
    || serverGroup.revision !== draft.revision
    || groupEditSignature(serverGroup) !== groupEditFormSignature(draft.baseline)
  );

  const { mutate, isPending } = useMutation({
    mutationFn: () => {
      if (pendingServerMerge) throw new Error('正在合并最新用户组快照，请稍后重试');
      const currentPayload = buildMinimalGroupEditPayload(form, draft.dirtyFields, authority);
      if (!currentPayload.success) throw new Error(currentPayload.error);
      return api.patch<GroupDto & TaskIdsResponse>(`/admin/groups/${group.id}`, {
        ...currentPayload.data,
        expectedRevision: draft.revision,
      });
    },
    onSuccess: (result) => {
      onTaskIds(result.taskIds);
      onAuthorityChanged();
      notifyAccessChangedForSubject({ type: 'group', id: group.id });
      void bootstrapAuthSession();
      toast({ title: '用户组已更新' });
      onClose();
    },
    onError: async (e) => {
      const current = apiErrorCurrent(e, 'GROUP_REVISION_CONFLICT', isGroupDto);
      if (current) {
        setDraft((draftState) => mergeAuthoritativeRevisionedServerBackedDraft(
          draftState,
          groupEditForm(current),
          current.revision,
        ));
      }
      if (current || (e instanceof ApiError && e.code === 'GROUP_REVISION_CONFLICT')) {
        onAuthorityChanged();
      }
      toast({
        title: current ? '服务器用户组已变化' : '更新失败',
        description: e instanceof Error ? e.message : '请重试',
        variant: 'destructive',
      });
    },
  });

  const assignable = new Set(assignableCapabilities);
  const hasUnassignableCapabilities = !group.isSystem
    && draft.dirtyFields.has('capabilities')
    && form.capabilities.some((cap) => !assignable.has(cap));
  const toggleCap = (cap: Capability) => {
    if (!assignable.has(cap)) return;
    setField('capabilities', (form.capabilities.includes(cap)
      ? form.capabilities.filter((candidate) => candidate !== cap)
      : [...form.capabilities, cap]).sort());
  };
  const hasChanges = draft.dirtyFields.size > 0;
  const hasConflicts = draft.conflictFields.size > 0;
  const serverChanged = Boolean(serverGroup
    && serverGroupSignature !== groupEditSignature(group));

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>编辑用户组：{group.name}</DialogTitle></DialogHeader>
        {serverChanged && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p>
              服务器上的用户组已更新。未修改字段已同步，本地修改已保留
              {hasConflicts ? `；${draft.conflictFields.size} 个字段发生冲突。` : '。'}
            </p>
            {hasConflicts && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setDraft(resolveRevisionedDraftConflicts(draft, 'use-server'))}>
                  使用服务器值
                </Button>
                <Button size="sm" onClick={() => setDraft(resolveRevisionedDraftConflicts(draft, 'keep-local'))}>
                  保留本地修改
                </Button>
              </div>
            )}
          </div>
        )}
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-sm">组名</Label>
              <Input value={form.name} disabled={group.isSystem || authorityPending || !authority.canEditMetadata}
                onChange={(e) => setField('name', e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-sm">优先级</Label>
              <Input type="number" min={0} max={MAX_GROUP_PRIORITY} step={1} value={form.priority}
                disabled={group.isSystem || authorityPending || !authority.canEditPriority}
                title={availability?.canEditPriority.reason ?? undefined}
                onChange={(e) => setField('priority', e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">描述</Label>
            <Input value={form.description} disabled={authorityPending || !authority.canEditMetadata}
              onChange={(e) => setField('description', e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">管理权限</Label>
            <div className="grid grid-cols-2 gap-2">
              {Object.entries(CAP_LABELS).map(([cap, label]) => (
                <label key={cap} className={`flex items-center gap-2 ${assignable.has(cap as Capability) && !group.isSystem ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
                  <input type="checkbox" checked={form.capabilities.includes(cap as Capability)}
                    disabled={group.isSystem || authorityPending || !authority.canEditMetadata || !assignable.has(cap as Capability)}
                    onChange={() => toggleCap(cap as Capability)} className="rounded" />
                  <span className="text-sm text-foreground/90">{label}</span>
                </label>
              ))}
            </div>
            {hasUnassignableCapabilities && (
              <p className="text-xs text-destructive">当前权限已变化，请关闭后重新打开编辑窗口。</p>
            )}
            {!payloadResult.success && hasChanges && !hasConflicts && (
              <p className="text-xs text-destructive">{payloadResult.error}</p>
            )}
          </div>
          {group.isSystem && (
            <p className="text-xs text-muted-foreground">内置用户组仅允许修改描述；名称、优先级和管理权限由系统固定。</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            onClick={() => mutate()}
            disabled={authorityPending || isPending || pendingServerMerge || !hasChanges || hasConflicts || !payloadResult.success || hasUnassignableCapabilities}
          >
            {isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function groupEditForm(group: GroupDto): GroupEditFormState {
  return {
    name: group.name,
    description: group.description ?? '',
    priority: String(group.priority),
    capabilities: [...group.capabilities].sort(),
  };
}

function groupEditSignature(group: GroupDto): string {
  return groupEditFormSignature(groupEditForm(group));
}

function groupEditFormSignature(form: GroupEditFormState): string {
  return JSON.stringify(form);
}
