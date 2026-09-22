import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, History, Terminal, TriangleAlert } from 'lucide-react';
import {
  Capability,
  ContainerStatus,
  type AttachVolumeRequest,
  type ContainerAction,
  type ContainerDto,
  type CursorPaginatedResponse,
  type EffectiveAccessDto,
  type IntentAcceptedDto,
  type IntentDto,
  type PatchContainerLimitsRequest,
  type PatchContainerRootSizeRequest,
  type SharedVolumeDto,
  type UserServerDto,
  type VolumeAttachmentDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { useAuthStore } from '../store/auth.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { Button } from '../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { StatusBadge } from '../components/layout/status-badge.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ContainerActionBar } from '../components/containers/container-action-bar.js';
import { ContainerConsole } from '../components/containers/container-console.js';
import { IntentsPanel } from '../components/containers/intents-panel.js';
import { OverviewPanel } from '../components/containers/overview-panel.js';
import { StoragePanel } from '../components/containers/storage-panel.js';
import { RootShrinkOrchestrationDialog } from '../components/storage/root-shrink-orchestration-dialog.js';
import { filterAttachableSharedVolumes, filterAttachableVolumes } from '../lib/attachable-volumes.js';
import {
  bindInProgress,
  containerLifecyclePending,
  containerStatusPending,
  intentListSettled,
} from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { runGatedMutation } from '../lib/resource-mutation-gate.js';
import { useResourceMutationPending } from '../hooks/use-resource-mutation-gate.js';
import {
  containerActionSubmittedTitle,
  containerStatusLabel,
  lifecyclePhaseLabel,
} from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';

const userRouteApi = getRouteApi('/containers/$containerId');
const adminRouteApi = getRouteApi('/manage/containers/$containerId');
export type DetailTab = 'overview' | 'console';
export const DETAIL_TABS: DetailTab[] = ['overview', 'console'];

const DETAIL_TAB_ITEMS = [
  ['overview', '概况', Gauge],
  ['console', '控制台', Terminal],
] as const;

export function parseDetailTab(value: unknown): DetailTab {
  return DETAIL_TABS.includes(value as DetailTab) ? (value as DetailTab) : 'overview';
}

export default function ContainerDetailPage() {
  const { containerId } = userRouteApi.useParams();
  const { tab } = userRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} admin={false} tab={tab} />;
}

export function AdminContainerDetailPage() {
  const { containerId } = adminRouteApi.useParams();
  const { tab } = adminRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} admin tab={tab} />;
}

function ContainerDetailContent({
  containerId,
  admin,
  tab,
}: {
  containerId: string;
  admin: boolean;
  tab: DetailTab;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: admin ? '/manage/containers/$containerId' : '/containers/$containerId' });
  const [rootOrchestrateSize, setRootOrchestrateSize] = useState<number | null>(null);
  const [detachTarget, setDetachTarget] = useState<VolumeAttachmentDto | null>(null);
  const [intentsOpen, setIntentsOpen] = useState(false);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageVolumes = capabilities.includes(Capability.ManageVolumes);
  const canManageSharedVolumes = capabilities.includes(Capability.ManageSharedVolumes);
  const actionPending = useResourceMutationPending(containerId);
  const volumesEnabled = tab === 'overview' && (!admin || canManageVolumes || canManageSharedVolumes);

  const base = admin ? `/admin/containers/${containerId}` : `/containers/${containerId}`;
  const containerQuery = useQuery({
    queryKey: queryKeys.containers.detail(admin ? 'admin' : 'user', containerId),
    queryFn: () => api.get<ContainerDto>(base),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 5_000 }),
  });
  const volumesQuery = useQuery({
    queryKey: admin ? queryKeys.volumes.admin : queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>(admin ? '/admin/volumes' : '/volumes'),
    enabled: volumesEnabled && (!admin || canManageVolumes),
  });
  const sharedVolumesQuery = useQuery({
    queryKey: [
      ...queryKeys.sharedVolumes.attachable(containerQuery.data?.serverId ?? ''),
      admin ? 'admin' : 'user',
    ],
    queryFn: () => api.get<SharedVolumeDto[]>(
      `${admin ? '/admin/shared-volumes' : '/shared-volumes'}?attachableOnServerId=${containerQuery.data!.serverId}`,
    ),
    enabled: volumesEnabled
      && Boolean(containerQuery.data?.serverId)
      && (!admin || canManageSharedVolumes),
  });
  const intentsQuery = useQuery({
    queryKey: queryKeys.containers.intents(admin ? 'admin' : 'user', containerId),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(`${base}/intents?limit=50`),
    enabled: intentsOpen,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (data) => intentListSettled(data.items),
    }),
  });
  const attachmentsQuery = useQuery({
    queryKey: queryKeys.containers.attachments(admin ? 'admin' : 'user', containerId),
    queryFn: async () => {
      const [local, shared] = await Promise.all([
        api.get<VolumeAttachmentDto[]>(`${base}/volumes`),
        api.get<VolumeAttachmentDto[]>(`${base}/shared-volumes`),
      ]);
      return [...local, ...shared];
    },
    enabled: tab === 'overview',
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (rows) => rows.every((row) => !bindInProgress(row.bindState)),
    }),
  });
  const serverQuery = useQuery({
    queryKey: queryKeys.servers.detail(containerQuery.data?.serverId ?? ''),
    queryFn: () => (
      admin
        ? api.get<UserServerDto>(`/admin/servers/${containerQuery.data!.serverId}`)
        : api.get<UserServerDto>(`/servers/${containerQuery.data!.serverId}`)
    ),
    enabled: Boolean(containerQuery.data?.serverId),
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    enabled: !admin && Boolean(containerQuery.data?.serverId),
  });
  const c = containerQuery.data;
  const extensionGrant = admin
    ? null
    : accessQuery.data?.servers.find((row) => row.serverId === c?.serverId)?.extensionGrants ?? null;

  const selectTab = (next: DetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true });
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.detail(admin ? 'admin' : 'user', containerId) });
    void queryClient.invalidateQueries({ queryKey: admin ? queryKeys.containers.adminList : queryKeys.containers.userList });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.attachments(admin ? 'admin' : 'user', containerId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.intents(admin ? 'admin' : 'user', containerId) });
  };

  const intentToast = (title: string, _intent?: IntentAcceptedDto) => {
    toast({ title });
  };

  const action = useMutation({
    mutationFn: (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) =>
      api.post<IntentAcceptedDto>(`${base}/actions/${name}`),
    onSuccess: (intent, name) => {
      intentToast(containerActionSubmittedTitle(name), intent);
      invalidate();
    },
    onError: (error) => toast({ title: '容器操作失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const updateLimits = useMutation({
    mutationFn: (body: PatchContainerLimitsRequest) => api.patch<IntentAcceptedDto>(`${base}/limits`, body),
    onSuccess: (intent) => { intentToast('已提交规格更新，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: '规格更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const resizeRoot = useMutation({
    mutationFn: (body: PatchContainerRootSizeRequest) => api.patch<IntentAcceptedDto>(`${base}/root-size`, body),
    onSuccess: (intent) => { intentToast('已提交系统盘调整，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: '系统盘调整失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const updateExtension = useMutation({
    mutationFn: ({ extensionId, payload }: { extensionId: string; payload: unknown }) =>
      api.patch<IntentAcceptedDto>(`${base}/extensions/${extensionId}`, payload),
    onSuccess: (intent) => { intentToast('已提交扩展更新，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: '扩展更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const attachLocal = useMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/volumes`, body),
    onSuccess: (intent) => { intentToast('已提交挂载，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: '挂载失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const attachShared = useMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/shared-volumes`, body),
    onSuccess: (intent) => { intentToast('已提交挂载，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: '挂载失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const detach = useMutation({
    mutationFn: (attachmentId: string) => {
      const path = detachTarget?.kind === 'shared' ? 'shared-volumes' : 'volumes';
      return api.delete<IntentAcceptedDto>(`${base}/${path}/${attachmentId}`);
    },
    onSuccess: (intent) => {
      intentToast('已提交卸载，正在生效', intent);
      setDetachTarget(null);
      invalidate();
    },
    onError: (error) => toast({ title: '卸载失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const repairSsh = useMutation({
    mutationFn: () => api.post<{ woken: boolean }>(`${base}/actions/repair-ssh`),
    onSuccess: () => {
      toast({
        title: '已提交 SSH 修复',
      });
      invalidate();
    },
    onError: (error) => toast({ title: 'SSH 修复失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const attachments = attachmentsQuery.data
    ?? [...(c?.volumes ?? []), ...(c?.sharedVolumes ?? [])];
  const attachedVolumeIds = useMemo(() => new Set(attachments.map((attachment) => attachment.volumeId)), [attachments]);
  const availableLocalVolumes = c
    ? filterAttachableVolumes(volumesQuery.data ?? [], c, attachedVolumeIds)
    : [];
  const availableSharedVolumes = c
    ? filterAttachableSharedVolumes(sharedVolumesQuery.data ?? [], c, attachedVolumeIds)
    : [];
  const canMutateLocal = !admin || canManageVolumes;
  const canMutateShared = !admin || canManageSharedVolumes;
  const localAttachBlockedReason = admin && !canManageVolumes
    ? '挂载与卸载本地数据卷需要「管理本地数据卷」权限；当前账号可以管理容器，但无法列出或挂载本地数据卷。'
    : null;
  const sharedAttachBlockedReason = admin && !canManageSharedVolumes
    ? '挂载与卸载共享卷需要「管理共享卷」权限；当前账号可以管理容器，但无法列出或挂载共享卷。'
    : null;

  const runAction = async (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) => {
    const ran = await runGatedMutation(containerId, () =>
      action.mutateAsync(name).then(() => undefined),
    );
    if (!ran) return Promise.reject();
  };

  const running = c?.actual.status === ContainerStatus.Running;

  const renderStoragePanel = (container: ContainerDto, loadedAttachments: VolumeAttachmentDto[]) => (
    <StoragePanel
      container={container}
      rootCapability={container.rootCapability}
      attachments={loadedAttachments}
      localVolumes={availableLocalVolumes}
      sharedVolumes={availableSharedVolumes}
      onAttachLocal={(body) => attachLocal.mutateAsync(body)}
      onAttachShared={(body) => attachShared.mutateAsync(body)}
      onDetachRequest={setDetachTarget}
      usages={[
        ...(volumesQuery.data ?? []).map((volume) => ({
          id: volume.id,
          sizeBytes: volume.sizeBytes,
          usedBytes: volume.usedBytes,
        })),
        ...(sharedVolumesQuery.data ?? []).map((volume) => ({
          id: volume.id,
          sizeBytes: volume.sizeBytes,
          usedBytes: volume.usedBytes,
        })),
      ]}
      onRootApply={(sizeBytes) => resizeRoot.mutateAsync({ sizeBytes })}
      onRootRequiresStop={setRootOrchestrateSize}
      pending={attachLocal.isPending || attachShared.isPending || detach.isPending}
      rootPending={resizeRoot.isPending}
      canMutateLocal={canMutateLocal}
      canMutateShared={canMutateShared}
      localAttachBlockedReason={localAttachBlockedReason}
      sharedAttachBlockedReason={sharedAttachBlockedReason}
      running={running}
    />
  );

  return (
    <Page testId="container-canonical-detail">
      <PageHeader
        title={
          c ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help underline decoration-dashed underline-offset-4">{c.name}</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-md">
                    <p className="break-all">实例名 {c.instanceName ?? '等待收敛'}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <StatusBadge
                label={containerStatusLabel(c.actual.status)}
                raw={c.actual.status}
                pending={containerStatusPending(c)}
                variant={running ? 'success' : c.needsAttention ? 'destructive' : 'secondary'}
              />
              {c.lifecyclePhase !== 'active' && (
                <StatusBadge
                  label={lifecyclePhaseLabel(c.lifecyclePhase)}
                  raw={c.lifecyclePhase}
                  pending={containerLifecyclePending(c)}
                  variant="warning"
                />
              )}
            </span>
          ) : '容器'
        }
        description={c ? c.serverName : undefined}
        crumbs={[
          admin
            ? { label: '容器管理', to: '/manage/containers' }
            : { label: '容器', to: '/containers' },
          { label: c?.name ?? '…' },
        ]}
        actions={c ? (
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 w-9 px-0"
              aria-label="意图历史"
              title="意图历史"
              data-testid="open-intent-history"
              onClick={() => setIntentsOpen(true)}
            >
              <History className="h-4 w-4" />
            </Button>
            <ContainerActionBar
              container={c}
              layout="labeled"
              pending={actionPending}
              showDelete
              onAction={(name) => runAction(name)}
            />
          </div>
        ) : undefined}
      />
      <QueryView
        query={containerQuery}
        resourceName="容器"
        loadingLabel="加载容器..."
        onBack={() => window.history.back()}
      >
        {(container) => (
          <>
            {container.needsAttention && (
              <Alert variant="destructive">
                <TriangleAlert className="h-4 w-4" />
                <AlertDescription>
                  {container.failureReason ?? container.failureCode ?? '容器需要人工关注。'}
                </AlertDescription>
              </Alert>
            )}

            <Tabs value={tab} onValueChange={(value) => selectTab(value as DetailTab)}>
              <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto">
                {DETAIL_TAB_ITEMS.map(([key, label, Icon]) => (
                  <TabsTrigger key={key} value={key} className="gap-1.5">
                    <Icon className="h-4 w-4" />{label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="overview" className="space-y-3">
                <OverviewPanel
                  container={container}
                  admin={admin}
                  enabledExtensions={serverQuery.data?.enabledExtensions ?? []}
                  grant={extensionGrant}
                  onRepairSsh={() => repairSsh.mutate()}
                  repairPending={repairSsh.isPending}
                  onLimits={(body) => updateLimits.mutateAsync(body)}
                  limitsPending={updateLimits.isPending}
                  onExtensionSubmit={(extensionId, payload) => updateExtension.mutateAsync({ extensionId, payload })}
                  extensionPending={updateExtension.isPending}
                />
                <QueryView
                  queries={[
                    attachmentsQuery,
                    ...(!admin || canManageVolumes ? [volumesQuery] : []),
                    ...((!admin || canManageSharedVolumes) && container.serverId
                      ? [sharedVolumesQuery]
                      : []),
                  ]}
                  resourceNames={[
                    '挂载',
                    ...(!admin || canManageVolumes ? ['数据卷'] : []),
                    ...((!admin || canManageSharedVolumes) && container.serverId
                      ? ['共享卷']
                      : []),
                  ]}
                  loadingLabel="加载存储..."
                >
                  {() => renderStoragePanel(container, attachmentsQuery.data ?? [])}
                </QueryView>
              </TabsContent>
              <TabsContent value="console">
                <ContainerConsole container={container} admin={admin} />
              </TabsContent>
            </Tabs>

            {rootOrchestrateSize !== null && (
              <RootShrinkOrchestrationDialog
                admin={admin}
                container={container}
                sizeBytes={rootOrchestrateSize}
                open
                onOpenChange={(open) => { if (!open) setRootOrchestrateSize(null); }}
                onComplete={invalidate}
              />
            )}

            <Dialog open={intentsOpen} onOpenChange={setIntentsOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>意图历史</DialogTitle>
                </DialogHeader>
                <QueryView
                  query={intentsQuery}
                  resourceName="意图历史"
                  loadingLabel="加载意图历史..."
                >
                  {(page) => (
                    <IntentsPanel
                      intents={page.items}
                      admin={admin}
                      embedded
                      onRetry={() => { void intentsQuery.refetch(); }}
                    />
                  )}
                </QueryView>
              </DialogContent>
            </Dialog>

            <ConfirmDialog
              open={Boolean(detachTarget)}
              title={detachTarget?.onlineCancelAllowed ? '取消挂载？' : '卸载数据卷？'}
              description={
                detachTarget
                  ? (detachTarget.onlineCancelAllowed
                    ? `将取消容器「${container.name}」路径 ${detachTarget.containerPath} 尚未完成的挂载。`
                    : `将从容器「${container.name}」卸载路径 ${detachTarget.containerPath}（设备 ${detachTarget.deviceName}）。`)
                  : null
              }
              confirmLabel={detachTarget?.onlineCancelAllowed ? '确认取消' : '确认卸载'}
              pendingLabel="提交中..."
              pending={detach.isPending}
              onConfirm={() => {
                if (!detachTarget) return;
                void detach.mutateAsync(detachTarget.id).then(() => undefined, () => undefined);
              }}
              onOpenChange={(open) => { if (!open) setDetachTarget(null); }}
            />
          </>
        )}
      </QueryView>
    </Page>
  );
}
