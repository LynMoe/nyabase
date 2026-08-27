import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Copy, Database, Gauge, HardDrive, History, KeyRound, Play, RotateCw, Square, Terminal, Trash2, TriangleAlert } from 'lucide-react';
import {
  Capability,
  ContainerStatus,
  IntentStatus,
  formatSshProxyJumpLogin,
  type AttachVolumeRequest,
  type ContainerAction,
  type ContainerDto,
  type CursorPaginatedResponse,
  type IntentAcceptedDto,
  type IntentDto,
  type PatchContainerGpuRequest,
  type PatchContainerLimitsRequest,
  type PatchContainerRootSizeRequest,
  type StoragePoolCapabilityDto,
  type VolumeAttachmentDto,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { usePublicSettings } from '../hooks/use-public-settings.js';
import { useAuthStore } from '../store/auth.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { ContainerConsole } from '../components/containers/container-console.js';
import { RootShrinkOrchestrationDialog } from '../components/storage/root-shrink-orchestration-dialog.js';
import {
  approxGibHint,
  formatBytes,
  formatCpu,
  formatGibInput,
  formatVcpuInput,
  gibToBytes,
  relativeTime,
  vcpuToMillis,
} from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  GpuPicker,
  formatGpuSelectionLabel,
  gpuModeFromPciList,
  resolveGpuPciAddresses,
  type GpuPickerMode,
  useServerGpus,
} from '../components/containers/gpu-picker.js';
import {
  classifySizeChange,
  observedRootUsedBytes,
  shrinkNeverTooltip,
  validateShrinkFloor,
} from '../lib/storage-shrink.js';
import {
  actionProgressHint,
  containerActionSubmittedTitle,
  intentKindLabel,
  intentStatusLabel,
  containerStatusLabel,
  lifecyclePhaseLabel,
  powerIntentLabel,
  sshStatusLabel,
} from '../lib/status-labels.js';
import { toast } from '../hooks/use-toast.js';
import { copyOneTimeSecret } from '../lib/one-time-secret.js';
import { filterAttachableVolumes } from '../lib/attachable-volumes.js';
import {
  formatIntentAttempt,
  formatIntentFailureMessage,
  isRetryableIntent,
  retryIntent,
} from '../lib/intent-visibility.js';

const userRouteApi = getRouteApi('/containers/$containerId');
const adminRouteApi = getRouteApi('/manage/containers/$containerId');
export type DetailTab = 'overview' | 'storage' | 'spec' | 'intents' | 'console';
export const DETAIL_TABS: DetailTab[] = ['overview', 'storage', 'spec', 'intents', 'console'];

export function parseDetailTab(value: unknown): DetailTab {
  return DETAIL_TABS.includes(value as DetailTab) ? (value as DetailTab) : 'overview';
}

export default function ContainerDetailPage() {
  const { containerId } = userRouteApi.useParams();
  const { tab } = userRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} admin={false} initialTab={tab} backTo="/containers" />;
}

export function AdminContainerDetailPage() {
  const { containerId } = adminRouteApi.useParams();
  const { tab } = adminRouteApi.useSearch();
  return <ContainerDetailContent containerId={containerId} admin initialTab={tab} backTo="/manage/containers" />;
}

function ContainerDetailContent({
  containerId,
  admin,
  initialTab,
  backTo,
}: {
  containerId: string;
  admin: boolean;
  initialTab: DetailTab;
  backTo: '/containers' | '/manage/containers';
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: admin ? '/manage/containers/$containerId' : '/containers/$containerId' });
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [rootSizeGib, setRootSizeGib] = useState('');
  const [cpuVcpus, setCpuVcpus] = useState('');
  const [memGib, setMemGib] = useState('');
  const [gpuMode, setGpuMode] = useState<GpuPickerMode>('none');
  const [gpuPciAddresses, setGpuPciAddresses] = useState<string[]>([]);
  const [volumeId, setVolumeId] = useState('');
  const [containerPath, setContainerPath] = useState('/data');
  const [readOnly, setReadOnly] = useState(false);
  const [rootOrchestrate, setRootOrchestrate] = useState(false);
  const [confirmAction, setConfirmAction] = useState<'stop' | 'restart' | 'delete' | null>(null);
  const [detachTarget, setDetachTarget] = useState<VolumeAttachmentDto | null>(null);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageVolumes = capabilities.includes(Capability.ManageVolumes);

  const base = admin ? `/admin/containers/${containerId}` : `/containers/${containerId}`;
  const containerQuery = useQuery({
    queryKey: queryKeys.containers.detail(admin ? 'admin' : 'user', containerId),
    queryFn: () => api.get<ContainerDto>(base),
    refetchInterval: 5_000,
  });
  const volumesQuery = useQuery({
    queryKey: admin ? queryKeys.volumes.admin : queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>(admin ? '/admin/volumes' : '/volumes'),
    enabled: tab === 'storage' && (!admin || canManageVolumes),
  });
  const intentsQuery = useQuery({
    queryKey: queryKeys.containers.intents(admin ? 'admin' : 'user', containerId),
    queryFn: () => api.get<CursorPaginatedResponse<IntentDto>>(`${base}/intents?limit=50`),
    enabled: tab === 'intents',
  });
  const attachmentsQuery = useQuery({
    queryKey: ['container-attachments', admin ? 'admin' : 'user', containerId],
    queryFn: () => api.get<VolumeAttachmentDto[]>(`${base}/volumes`),
    enabled: tab === 'storage',
  });
  const gpusQuery = useServerGpus(
    containerQuery.data?.serverId,
    admin,
    Boolean(containerQuery.data?.serverId) && (tab === 'spec' || tab === 'overview'),
  );
  const c = containerQuery.data;

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!c) return;
    setRootSizeGib(formatGibInput(c.rootSizeBytes));
    setCpuVcpus(formatVcpuInput(c.cpuMillis));
    setMemGib(formatGibInput(c.memBytes));
    setGpuPciAddresses(c.gpuPciAddresses);
    setGpuMode(gpuModeFromPciList(c.gpuPciAddresses, gpusQuery.data?.items.length));
  }, [c, gpusQuery.data?.items.length]);

  const selectTab = (next: DetailTab) => {
    setTab(next);
    void navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true });
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.detail(admin ? 'admin' : 'user', containerId) });
    void queryClient.invalidateQueries({ queryKey: admin ? queryKeys.containers.adminList : queryKeys.containers.userList });
    void queryClient.invalidateQueries({ queryKey: ['container-attachments', admin ? 'admin' : 'user', containerId] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.containers.intents(admin ? 'admin' : 'user', containerId) });
  };

  const intentToast = (title: string, _intent?: IntentAcceptedDto) => {
    toast({
      title,
      description: actionProgressHint('detail'),
    });
  };

  const action = useMutation({
    mutationFn: (name: Extract<ContainerAction, 'start' | 'stop' | 'restart' | 'delete'>) =>
      api.post<IntentAcceptedDto>(`${base}/actions/${name}`),
    onSuccess: (intent, name) => {
      intentToast(containerActionSubmittedTitle(name), intent);
      setConfirmAction(null);
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
  const updateGpu = useMutation({
    mutationFn: (body: PatchContainerGpuRequest) => api.patch<IntentAcceptedDto>(`${base}/gpu`, body),
    onSuccess: (intent) => { intentToast('已提交 GPU 更新，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: 'GPU 更新失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const attach = useMutation({
    mutationFn: (body: AttachVolumeRequest) => api.post<IntentAcceptedDto>(`${base}/volumes`, body),
    onSuccess: (intent) => { intentToast('已提交挂载，正在生效', intent); invalidate(); },
    onError: (error) => toast({ title: '挂载失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const detach = useMutation({
    mutationFn: (attachmentId: string) => api.delete<IntentAcceptedDto>(`${base}/volumes/${attachmentId}`),
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
        description: '正在重写 authorized_keys 并探测 sshd…',
      });
      invalidate();
    },
    onError: (error) => toast({ title: 'SSH 修复失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const attachments = attachmentsQuery.data ?? c?.volumes ?? [];
  const attachedVolumeIds = useMemo(() => new Set(attachments.map((attachment) => attachment.volumeId)), [attachments]);
  const availableVolumes = c
    ? filterAttachableVolumes(volumesQuery.data ?? [], c, attachedVolumeIds)
    : [];
  const canMutateAttachments = !admin || canManageVolumes;
  const attachBlockedReason = admin && !canManageVolumes
    ? '挂载与卸载需要「管理数据卷」权限；当前账号可以管理容器，但无法列出或挂载全部数据卷。'
    : null;

  if (containerQuery.isLoading) return <QueryLoadingState label="加载容器..." />;
  if (containerQuery.isError) return <QueryErrorState error={containerQuery.error} resourceName="容器" onRetry={() => { void containerQuery.refetch(); }} onBack={() => window.history.back()} />;
  if (!c) return null;

  const running = c.actual.status === ContainerStatus.Running;
  const actionDisabled = action.isPending;
  const canEditGpu = !running && c.actions.start.enabled;
  const rootSizeBytes = Number.isFinite(Number(rootSizeGib)) ? gibToBytes(Number(rootSizeGib)) : NaN;
  const cpuMillis = Number.isFinite(Number(cpuVcpus)) ? vcpuToMillis(Number(cpuVcpus)) : NaN;
  const memBytes = Number.isFinite(Number(memGib)) ? gibToBytes(Number(memGib)) : NaN;

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="container-canonical-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <Link to={backTo}><Button variant="outline" size="icon" aria-label="返回容器"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight">{c.name}</h1>
              <Badge
                variant={running ? 'success' : c.needsAttention ? 'destructive' : 'secondary'}
                title={c.actual.status}
              >
                {containerStatusLabel(c.actual.status)}
              </Badge>
              {c.lifecyclePhase !== 'active' && (
                <Badge variant="warning" title={c.lifecyclePhase}>
                  {lifecyclePhaseLabel(c.lifecyclePhase)}
                </Badge>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {c.serverName} · 实例名 {c.instanceName ?? '等待实例身份'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          <ActionButton action="start" icon={Play} container={c} onClick={() => action.mutate('start')} pending={actionDisabled} />
          <ActionButton action="stop" icon={Square} container={c} onClick={() => setConfirmAction('stop')} pending={actionDisabled} />
          <ActionButton action="restart" icon={RotateCw} container={c} onClick={() => setConfirmAction('restart')} pending={actionDisabled} />
          <Button
            size="sm"
            variant="destructive"
            disabled={!c.actions.delete.enabled || actionDisabled}
            title={c.actions.delete.message}
            onClick={() => setConfirmAction('delete')}
          >
            <Trash2 className="h-4 w-4" />删除
          </Button>
        </div>
      </div>

      {c.needsAttention && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{c.failureReason ?? c.failureCode ?? '容器需要人工关注。'}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b">
        {([
          ['overview', '概览', Gauge],
          ['storage', '存储', Database],
          ['spec', '规格', HardDrive],
          ['intents', '意图历史', History],
          ['console', '控制台', Terminal],
        ] as const).map(([key, label, Icon]) => (
          <Button key={key} size="sm" variant={tab === key ? 'default' : 'ghost'} onClick={() => selectTab(key)}>
            <Icon className="h-4 w-4" />{label}
          </Button>
        ))}
      </div>

      {tab === 'overview' && (
        <OverviewPanel
          container={c}
          gpuInventory={gpusQuery.data?.items ?? []}
          onRepairSsh={() => repairSsh.mutate()}
          repairPending={repairSsh.isPending}
        />
      )}
      {tab === 'storage' && (
        <StoragePanel
          container={c}
          rootCapability={c.rootCapability}
          attachments={attachments}
          volumes={availableVolumes}
          volumeId={volumeId}
          containerPath={containerPath}
          readOnly={readOnly}
          onVolumeId={setVolumeId}
          onContainerPath={setContainerPath}
          onReadOnly={setReadOnly}
          onAttach={() => {
            const request: AttachVolumeRequest = { volumeId, containerPath, readOnly };
            attach.mutate(request);
          }}
          onDetachRequest={setDetachTarget}
          pending={attach.isPending || detach.isPending}
          loading={volumesQuery.isLoading || attachmentsQuery.isLoading}
          canMutateAttachments={canMutateAttachments}
          attachBlockedReason={attachBlockedReason}
        />
      )}
      {tab === 'spec' && (
        <SpecPanel
          container={c}
          admin={admin}
          rootCapability={c.rootCapability}
          cpuVcpus={cpuVcpus}
          memGib={memGib}
          rootSizeGib={rootSizeGib}
          gpuMode={gpuMode}
          gpuPciAddresses={gpuPciAddresses}
          memBytes={memBytes}
          rootSizeBytes={rootSizeBytes}
          onCpuVcpus={setCpuVcpus}
          onMemGib={setMemGib}
          onRootSizeGib={setRootSizeGib}
          onGpuMode={setGpuMode}
          onGpuPciAddresses={setGpuPciAddresses}
          onLimits={() => {
            if (!Number.isFinite(cpuMillis) || !Number.isFinite(memBytes)) {
              toast({ title: '请输入有效的 CPU / 内存', variant: 'destructive' });
              return;
            }
            updateLimits.mutate({ cpuMillis, memBytes });
          }}
          onRoot={() => {
            if (!Number.isFinite(rootSizeBytes)) {
              toast({ title: '请输入有效的系统盘容量', variant: 'destructive' });
              return;
            }
            const capability = c.rootCapability;
            const path = classifySizeChange(capability, c.rootSizeBytes, rootSizeBytes);
            if (path === 'never') {
              toast({ title: '无法缩容', description: shrinkNeverTooltip(), variant: 'destructive' });
              return;
            }
            const floor = validateShrinkFloor(capability, rootSizeBytes, observedRootUsedBytes(c));
            if (floor) {
              toast({ title: '容量不合法', description: floor, variant: 'destructive' });
              return;
            }
            if (path === 'requires_stop') {
              setRootOrchestrate(true);
              return;
            }
            resizeRoot.mutate({ sizeBytes: rootSizeBytes });
          }}
          onGpu={() => {
            const inventory = gpusQuery.data?.items ?? [];
            updateGpu.mutate({
              gpuPciAddresses: resolveGpuPciAddresses(gpuMode, gpuPciAddresses, inventory),
            });
          }}
          limitsPending={updateLimits.isPending}
          rootPending={resizeRoot.isPending}
          gpuPending={updateGpu.isPending}
          canEditGpu={canEditGpu}
        />
      )}
      {rootOrchestrate && Number.isFinite(rootSizeBytes) && (
        <RootShrinkOrchestrationDialog
          admin={admin}
          container={c}
          sizeBytes={rootSizeBytes}
          open={rootOrchestrate}
          onOpenChange={setRootOrchestrate}
          onComplete={invalidate}
        />
      )}
      {tab === 'intents' && (
        <IntentHistory
          intents={intentsQuery.data?.items ?? []}
          loading={intentsQuery.isLoading}
          error={intentsQuery.error}
          admin={admin}
          onRetry={() => { void intentsQuery.refetch(); }}
        />
      )}
      {tab === 'console' && <ContainerConsole container={c} admin={admin} />}

      <Dialog open={Boolean(confirmAction)} onOpenChange={(open) => { if (!open) setConfirmAction(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction === 'delete' ? '删除容器？' : confirmAction === 'stop' ? '停止容器？' : '重启容器？'}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === 'delete'
                ? `将永久删除容器「${c.name}」。数据卷会保留，仅解除挂载。此操作不可恢复。`
                : confirmAction === 'stop'
                  ? `将停止容器「${c.name}」。运行中的进程与 SSH 会话会中断。`
                  : `将重启容器「${c.name}」。运行中的进程与 SSH 会话会短暂中断。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)} disabled={actionDisabled}>取消</Button>
            <Button
              variant={confirmAction === 'restart' ? 'default' : 'destructive'}
              disabled={actionDisabled || !confirmAction}
              onClick={() => {
                if (confirmAction) action.mutate(confirmAction);
              }}
            >
              {actionDisabled
                ? '提交中...'
                : confirmAction === 'delete'
                  ? '确认删除'
                  : confirmAction === 'stop'
                    ? '确认停止'
                    : '确认重启'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detachTarget)} onOpenChange={(open) => { if (!open) setDetachTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>热卸载数据卷？</DialogTitle>
            <DialogDescription>
              {detachTarget
                ? `将从容器「${c.name}」卸载路径 ${detachTarget.containerPath}（设备 ${detachTarget.deviceName}）。运行中卸载可能导致应用写入失败。`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetachTarget(null)} disabled={detach.isPending}>取消</Button>
            <Button
              variant="destructive"
              disabled={detach.isPending || !detachTarget}
              onClick={() => {
                if (detachTarget) detach.mutate(detachTarget.id);
              }}
            >
              {detach.isPending ? '提交中...' : '确认卸载'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function OverviewPanel({
  container,
  gpuInventory,
  onRepairSsh,
  repairPending,
}: {
  container: ContainerDto;
  gpuInventory: Array<{ index: number | null; pciAddress: string; model: string }>;
  onRepairSsh: () => void;
  repairPending: boolean;
}) {
  const { settings } = usePublicSettings();
  const authUser = useAuthStore((state) => state.user);
  const username = container.ownerName ?? authUser?.username ?? '<username>';
  const jumpLogin = formatSshProxyJumpLogin({
    username,
    containerName: container.name,
  });
  const proxyHostValue = container.ssh.proxyHost?.trim()
    || settings.sshProxy?.host
    || null;
  const proxyPortValue = container.ssh.proxyPort
    ?? settings.sshProxy?.port
    ?? null;
  const proxyHost = proxyHostValue
    ? (proxyPortValue && proxyPortValue !== 22
      ? `${proxyHostValue}:${proxyPortValue}`
      : proxyHostValue)
    : null;
  const routedIp = container.routedIp;
  const loginUser = container.ssh.loginUser || 'root';
  const jumpCommand = proxyHost && routedIp
    ? `ssh -J ${jumpLogin}@${proxyHost} ${loginUser}@${routedIp}`
    : null;
  const configSnippet = proxyHost && routedIp
    ? [
      `Host ${container.name}`,
      `  HostName ${routedIp}`,
      `  User ${loginUser}`,
      `  ProxyJump ${jumpLogin}@${proxyHost}`,
    ].join('\n')
    : null;
  const copyText = async (value: string, title: string) => {
    const ok = await copyOneTimeSecret(value);
    toast({
      title: ok ? title : '复制失败',
      description: ok ? undefined : '请手动选中后复制',
      variant: ok ? 'default' : 'destructive',
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="container-overview">
      <Card>
        <CardHeader><CardTitle className="text-base">容器信息</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info label="镜像指纹" value={container.imageFingerprint} mono />
          <Info label="实例名" value={container.instanceName ?? '等待收敛'} mono />
          <Info label="容器 IP" value={container.routedIp ?? '等待容器 IP'} mono />
          <Info label="期望电源" value={powerIntentLabel(container.powerIntent)} title={container.powerIntent} />
          <Info label="实际状态" value={containerStatusLabel(container.actual.status)} title={container.actual.status} />
          <Info label="观测时间" value={relativeTime(container.actual.observedAt)} />
        </CardContent>
      </Card>
      <Card data-testid="ssh-routed-instance-identity">
        <CardHeader>
          <CardTitle className="text-base">SSH 登录信息</CardTitle>
          <CardDescription>
            通过 SSH 代理 Jump 到容器：第一跳校验平台公钥与路由，第二跳由客户端与容器 sshd 端到端验钥。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Info label="登录用户" value={container.ssh.loginUser} mono />
          <Info label="SSH 状态" value={sshStatusLabel(container.ssh.status)} title={container.ssh.status} />
          <Info label="容器主机密钥指纹" value={container.ssh.hostKeyFingerprint ?? '尚未观测'} mono />
          {!proxyHost ? (
            <p className="text-sm text-muted-foreground">管理员尚未配置 SSH 代理公网地址</p>
          ) : !routedIp ? (
            <p className="text-sm text-muted-foreground">等待容器地址</p>
          ) : (
            <>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">Jump 命令</p>
                  <Button size="sm" variant="outline" onClick={() => { void copyText(jumpCommand!, 'Jump 命令已复制'); }}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="ssh-jump-command">{jumpCommand}</pre>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">~/.ssh/config 片段</p>
                  <Button size="sm" variant="outline" onClick={() => { void copyText(configSnippet!, 'SSH 配置已复制'); }}>
                    <Copy className="h-3.5 w-3.5" />复制
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-xs" data-testid="ssh-jump-config">{configSnippet}</pre>
              </div>
            </>
          )}
          {container.ssh.lastError && <p className="break-all text-xs text-destructive">{container.ssh.lastError}</p>}
          <Button
            size="sm"
            variant="outline"
            disabled={repairPending || container.lifecyclePhase !== 'active'}
            onClick={onRepairSsh}
            data-testid="repair-ssh"
          >
            <KeyRound className="h-4 w-4" />
            {repairPending ? '修复中…' : '修复 SSH'}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">资源</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info label="CPU" value={formatCpu(container.cpuMillis)} />
          <Info label="内存" value={approxGibHint(container.memBytes).replace(/^约 /, '')} />
          <Info label="GPU" value={formatGpuSelectionLabel(container.gpuPciAddresses, gpuInventory)} />
          <Info
            label="系统盘"
            value={`${approxGibHint(container.rootSizeBytes).replace(/^约 /, '')}${container.rootSizePendingBytes === null ? '' : `（待应用 ${approxGibHint(container.rootSizePendingBytes).replace(/^约 /, '')}）`}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function StoragePanel({
  container,
  rootCapability,
  attachments,
  volumes,
  volumeId,
  containerPath,
  readOnly,
  onVolumeId,
  onContainerPath,
  onReadOnly,
  onAttach,
  onDetachRequest,
  pending,
  loading,
  canMutateAttachments,
  attachBlockedReason,
}: {
  container: ContainerDto;
  rootCapability: StoragePoolCapabilityDto;
  attachments: VolumeAttachmentDto[];
  volumes: VolumeDto[];
  volumeId: string;
  containerPath: string;
  readOnly: boolean;
  onVolumeId: (value: string) => void;
  onContainerPath: (value: string) => void;
  onReadOnly: (value: boolean) => void;
  onAttach: () => void;
  onDetachRequest: (attachment: VolumeAttachmentDto) => void;
  pending: boolean;
  loading: boolean;
  canMutateAttachments: boolean;
  attachBlockedReason: string | null;
}) {
  const shrinkHint = rootCapability.shrinkNever
    ? shrinkNeverTooltip()
    : rootCapability.shrinkRequiresStop
      ? '缩容需先停止容器'
      : rootCapability.shrinkOnline
        ? '可在线缩容'
        : '缩容受用量约束';
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="container-storage">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">系统盘</CardTitle>
          <CardDescription>系统盘所在池由容器创建时固定；扩缩路径由池能力决定。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Info
            label="存储池"
            value={container.rootPoolName}
            mono={container.rootPoolName === container.rootPoolId}
          />
          <Info label="容量" value={formatBytes(container.rootSizeBytes)} />
          <Info label="已用" value={observedRootUsedLabel(container)} />
          <Info
            label="待应用"
            value={container.rootSizePendingBytes === null ? '无' : formatBytes(container.rootSizePendingBytes)}
          />
          <Info label="缩容能力" value={shrinkHint} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">数据卷热挂载</CardTitle>
          <CardDescription>运行中的容器可以直接挂载或卸载数据卷。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="attach-volume">数据卷</Label>
            <select
              id="attach-volume"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={volumeId}
              onChange={(event) => onVolumeId(event.target.value)}
              disabled={!canMutateAttachments}
            >
              <option value="">选择数据卷</option>
              {volumes.map((volume) => (
                <option key={volume.id} value={volume.id}>
                  {volume.name} · {formatBytes(volume.sizeBytes)}
                  {volume.capability.shrinkNever ? ' · 不可缩容' : volume.capability.shrinkRequiresStop ? ' · 缩容需卸载' : ''}
                </option>
              ))}
            </select>
            {attachBlockedReason && (
              <p className="text-xs text-muted-foreground" data-testid="attach-capability-hint">{attachBlockedReason}</p>
            )}
            {canMutateAttachments && volumes.length === 0 && !loading && (
              <p className="text-xs text-muted-foreground">
                暂无可用数据卷。
                <Link to="/volumes" className="ml-1 underline">去创建数据卷</Link>
              </p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="attach-path">容器路径</Label>
              <Input id="attach-path" value={containerPath} onChange={(event) => onContainerPath(event.target.value)} />
            </div>
            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" checked={readOnly} onChange={(event) => onReadOnly(event.target.checked)} />
              只读
            </label>
          </div>
          <Button onClick={onAttach} disabled={pending || loading || !canMutateAttachments || !volumeId || !containerPath.startsWith('/')}>
            {pending ? '提交中...' : '热挂载'}
          </Button>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-base">当前挂载</CardTitle></CardHeader>
        <CardContent>
          {attachments.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无数据卷挂载。</p>
          ) : (
            <div className="divide-y rounded-md border">
              {attachments.map((attachment) => (
                <div key={attachment.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm">
                  <div>
                    <p className="font-mono text-xs">{attachment.containerPath}</p>
                    <p className="text-xs text-muted-foreground">
                      卷 {attachment.volumeName} · 设备 {attachment.deviceName} · {attachment.readOnly ? '只读' : '读写'}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => onDetachRequest(attachment)} disabled={pending || !canMutateAttachments}>热卸载</Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SpecPanel({
  container,
  admin,
  rootCapability,
  cpuVcpus,
  memGib,
  rootSizeGib,
  gpuMode,
  gpuPciAddresses,
  memBytes,
  rootSizeBytes,
  onCpuVcpus,
  onMemGib,
  onRootSizeGib,
  onGpuMode,
  onGpuPciAddresses,
  onLimits,
  onRoot,
  onGpu,
  limitsPending,
  rootPending,
  gpuPending,
  canEditGpu,
}: {
  container: ContainerDto;
  admin: boolean;
  rootCapability: StoragePoolCapabilityDto;
  cpuVcpus: string;
  memGib: string;
  rootSizeGib: string;
  gpuMode: GpuPickerMode;
  gpuPciAddresses: string[];
  memBytes: number;
  rootSizeBytes: number;
  onCpuVcpus: (value: string) => void;
  onMemGib: (value: string) => void;
  onRootSizeGib: (value: string) => void;
  onGpuMode: (value: GpuPickerMode) => void;
  onGpuPciAddresses: (value: string[]) => void;
  onLimits: () => void;
  onRoot: () => void;
  onGpu: () => void;
  limitsPending: boolean;
  rootPending: boolean;
  gpuPending: boolean;
  canEditGpu: boolean;
}) {
  const path = Number.isFinite(rootSizeBytes)
    ? classifySizeChange(rootCapability, container.rootSizeBytes, rootSizeBytes)
    : 'unchanged';
  const shrinkBlocked = path === 'never';
  const rootDescription = path === 'never'
    ? shrinkNeverTooltip()
    : path === 'requires_stop'
      ? '缩容需要先停止容器；将引导停止 → 缩容 → 可选启动。'
      : path === 'online'
        ? '在线缩容：直接提交，无停机提示。'
        : '扩容在线执行；缩容路径由池能力决定。';

  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="container-spec">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">CPU / 内存</CardTitle>
          <CardDescription>这两个字段支持在线变更，提交后会开始生效。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <UnitInput
              id="limit-cpu"
              label="CPU (核)"
              value={cpuVcpus}
              onChange={onCpuVcpus}
              step="0.1"
            />
            <UnitInput
              id="limit-memory"
              label="内存 (GiB)"
              value={memGib}
              onChange={onMemGib}
              hint={Number.isFinite(memBytes) ? approxGibHint(memBytes) : undefined}
            />
          </div>
          <Button onClick={onLimits} disabled={limitsPending}>{limitsPending ? '提交中...' : '在线应用规格'}</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">系统盘容量</CardTitle>
          <CardDescription>{rootDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <UnitInput
            id="root-size"
            label="目标容量 (GiB)"
            value={rootSizeGib}
            onChange={onRootSizeGib}
            hint={Number.isFinite(rootSizeBytes) ? approxGibHint(rootSizeBytes) : undefined}
          />
          {shrinkBlocked && <p className="text-xs text-muted-foreground">{shrinkNeverTooltip()}</p>}
          <Button
            onClick={onRoot}
            disabled={rootPending || shrinkBlocked}
            title={shrinkBlocked ? shrinkNeverTooltip() : undefined}
          >
            {rootPending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '应用系统盘容量'}
          </Button>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">GPU</CardTitle>
          <CardDescription data-testid="gpu-runtime-rebuild">
            {!container.nvidiaRuntime
              ? '该容器创建时未启用 NVIDIA runtime，无法热添加 GPU，请删除后重建。'
              : canEditGpu
                ? '容器已停止，可以修改 GPU。'
                : 'GPU 修改要求容器停止。'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <GpuPicker
            serverId={container.serverId}
            admin={admin}
            mode={gpuMode}
            onModeChange={onGpuMode}
            value={gpuPciAddresses}
            onChange={onGpuPciAddresses}
            disabled={!container.nvidiaRuntime || !canEditGpu}
            idPrefix="container-detail-gpu"
          />
          <Button
            onClick={onGpu}
            disabled={gpuPending || !container.nvidiaRuntime || !canEditGpu}
          >
            {gpuPending ? '提交中...' : '应用 GPU'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function IntentHistory({
  intents,
  loading,
  error,
  admin,
  onRetry,
}: {
  intents: IntentDto[];
  loading: boolean;
  error: unknown;
  admin: boolean;
  onRetry: () => void;
}) {
  const retry = useMutation({
    mutationFn: (intentId: string) => retryIntent(intentId, admin),
    onSuccess: () => {
      toast({ title: '已提交重试' });
      onRetry();
    },
    onError: (error) => toast({
      title: '重试失败',
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
  });
  if (loading) return <QueryLoadingState label="加载意图历史..." />;
  if (error) return <QueryErrorState error={error} resourceName="意图历史" onRetry={onRetry} />;
  return (
    <Card data-testid="intent-history">
      <CardHeader>
        <CardTitle className="text-base">意图历史</CardTitle>
        <CardDescription>显示请求人、操作类型、尝试次数、结果与错误说明。</CardDescription>
      </CardHeader>
      <CardContent>
        {intents.length === 0 ? (
          <p className="text-sm text-muted-foreground">暂无操作记录。</p>
        ) : (
          <div className="divide-y rounded-md border">
            {intents.map((intent) => {
              const failure = formatIntentFailureMessage(intent);
              return (
                <div key={intent.id} className="space-y-1 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{intentKindLabel(intent.kind)}</span>
                    <Badge
                      title={intent.status}
                      variant={intent.status === IntentStatus.Succeeded ? 'success' : intent.status === IntentStatus.Failed ? 'destructive' : 'warning'}
                    >
                      {intentStatusLabel(intent.status)}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {intent.requestedBy ?? '系统'} · {new Date(intent.createdAt).toLocaleString()} · {formatIntentAttempt(intent)}
                  </div>
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs">{JSON.stringify(intent.requestSummary)}</pre>
                  {failure && (
                    <p className="break-all text-xs text-destructive">{failure}</p>
                  )}
                  {isRetryableIntent(intent) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={retry.isPending}
                      onClick={() => retry.mutate(intent.id)}
                    >
                      {retry.isPending && retry.variables === intent.id ? '提交中...' : '重试'}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActionButton({
  action,
  icon: Icon,
  container,
  onClick,
  pending,
}: {
  action: Extract<ContainerAction, 'start' | 'stop' | 'restart'>;
  icon: typeof Play;
  container: ContainerDto;
  onClick: () => void;
  pending: boolean;
}) {
  const availability = container.actions[action];
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={!availability.enabled || pending}
      title={availability.message ?? availability.reason}
    >
      <Icon className="h-4 w-4" />
      {action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}
    </Button>
  );
}

function UnitInput({
  id,
  label,
  value,
  onChange,
  hint,
  step = '1',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  step?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" min="0" step={step} value={value} onChange={(event) => onChange(event.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Info({ label, value, mono = false, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'} title={title}>{value}</p>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}

function observedRootUsedLabel(container: ContainerDto): string {
  const used = observedRootUsedBytes(container);
  return used === null ? '未知' : formatBytes(used);
}
