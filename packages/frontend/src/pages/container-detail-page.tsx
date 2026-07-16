import { Link, getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, BarChart2, ChevronDown, Info, Loader2, Power, Terminal, Trash2 } from 'lucide-react';
import { AgentTaskStatus, Capability, ContainerStatus, type AgentTaskRefResponse, type ContainerAction, type ContainerMetrics, type ContainerMetricsDto, type ContainerView } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { formatBytesCompact, formatBytesLimit, formatCpu } from '../lib/utils.js';
import { useAuthStore } from '../store/auth.js';
import { MountsCard } from '../components/containers/mounts-card.js';
import { toast } from '../hooks/use-toast.js';
import { isPendingAgentTaskStatus, useAgentTaskTracker } from '../hooks/use-agent-task-tracker.js';
import { containerActionPath } from '../lib/container-actions.js';
import { ContainerConsole } from '../components/containers/container-console.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu.js';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../components/ui/tooltip.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import {
  EmptyChart,
  InlineSingleLineChart,
  TimeRangeSelector,
  zeroFillSeriesFromReferences,
} from '../components/dashboard/server-metrics.js';

const routeApi = getRouteApi('/containers/$containerId');
const adminRouteApi = getRouteApi('/manage/containers/$containerId');
type ContainerDetailPlane = 'admin' | 'user';

function actionTitle(container: ContainerView, action: ContainerAction): string | undefined {
  const availability = container.actions[action];
  return availability.enabled ? undefined : availability.message ?? availability.reason;
}

const ACTION_LABELS: Partial<Record<ContainerAction, string>> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  delete: '删除',
  reconcileSsh: '修复 SSH',
};

const TASK_KIND_LABELS: Record<string, string> = {
  'container.create': 'creating',
  'container.start': 'starting',
  'container.stop': 'stopping',
  'container.restart': 'restarting',
  'container.delete': 'deleting',
  'container.update_mounts': 'updating mounts',
  'container.reconcile_ssh': 'repairing SSH',
};

const TASK_STATUS_LABELS: Record<AgentTaskStatus, string> = {
  [AgentTaskStatus.Pending]: '任务处理中',
  [AgentTaskStatus.Succeeded]: '已完成',
  [AgentTaskStatus.Failed]: '失败',
};

function taskStatusLabel(status: AgentTaskStatus | string | null | undefined): string {
  return status ? TASK_STATUS_LABELS[status as AgentTaskStatus] ?? String(status) : '任务';
}

function taskBadgeTitle(task: ContainerView['activeTask']): string | undefined {
  if (!task) return undefined;
  return `${task.kind} · ${taskStatusLabel(task.status)}`;
}

function taskVariant(status: AgentTaskStatus | string | null | undefined): 'success' | 'destructive' | 'warning' | 'secondary' | 'outline' {
  if (status === AgentTaskStatus.Failed) return 'destructive';
  if (status === AgentTaskStatus.Succeeded) return 'success';
  if (isPendingAgentTaskStatus(status)) return 'warning';
  return 'outline';
}

function taskErrorMessage(task: ContainerView['activeTask']): string | null {
  if (!task || typeof task.error !== 'object' || task.error === null) return null;
  const message = (task.error as { message?: unknown }).message;
  return typeof message === 'string' && message.trim() ? message : null;
}

export default function ContainerDetailPage() {
  const { containerId } = routeApi.useParams();
  const { tab: initialTab } = routeApi.useSearch();
  return (
    <ContainerDetailContent
      containerId={containerId}
      initialTab={initialTab}
      plane="user"
      backTo="/containers"
    />
  );
}

export function AdminContainerDetailPage() {
  const { containerId } = adminRouteApi.useParams();
  const { tab: initialTab } = adminRouteApi.useSearch();
  return (
    <ContainerDetailContent
      containerId={containerId}
      initialTab={initialTab}
      plane="admin"
      backTo="/manage/containers"
    />
  );
}

function ContainerDetailContent({
  containerId,
  initialTab,
  plane,
  backTo,
}: {
  containerId: string;
  initialTab: 'overview' | 'console';
  plane: ContainerDetailPlane;
  backTo: '/containers' | '/manage/containers';
}) {
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'console'>(initialTab);
  const [metricsRange, setMetricsRange] = useState('1h');
  const [trackedTaskId, setTrackedTaskId] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  useAgentTaskTracker(trackedTaskId, { admin: plane === 'admin' });

  const apiBasePath = plane === 'admin' ? '/admin/v2/containers' : '/v2/containers';
  const metricsBasePath = plane === 'admin' ? '/admin/metrics' : '/metrics';
  const canViewMetrics = plane !== 'admin' || (user?.capabilities.includes(Capability.ViewMetricsAll) ?? false);

  const { data: c } = useQuery({
    queryKey: queryKeys.containers.detail(plane, containerId),
    queryFn: () => api.get<ContainerView>(`${apiBasePath}/${containerId}`),
    refetchInterval: 5_000,
  });

  const { data: metricsData, isLoading: metricsLoading, isError: metricsError } = useQuery({
    queryKey: ['metrics-container-detail', plane, c?.serverId, containerId, c?.runtime.runtimeId, metricsRange],
    queryFn: () => api.get<ContainerMetricsDto>(`${metricsBasePath}/servers/${c!.serverId}/containers?range=${metricsRange}`),
    enabled: activeTab === 'overview' && Boolean(c?.serverId) && canViewMetrics,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const runAction = useMutation({
    mutationFn: (action: ContainerAction) => api.post<AgentTaskRefResponse>(`${apiBasePath}/${containerId}/actions/${containerActionPath(action)}`),
    onSuccess: (res) => {
      setTrackedTaskId(res.taskId);
      toast({ title: '任务已排队', description: `任务 ${res.taskId.slice(0, 8)}` });
      void qc.invalidateQueries({ queryKey: queryKeys.containers.detail(plane, containerId) });
      void qc.invalidateQueries({ queryKey: plane === 'admin' ? queryKeys.containers.adminList : queryKeys.containers.userList });
    },
    onError: (e) => toast({ title: '操作失败', description: (e as Error).message, variant: 'destructive' }),
  });

  if (!c) return <div className="px-4 py-4 md:px-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />加载中...</div>;

  const running = c.runtime.status === ContainerStatus.Running;
  const canManageContainer = plane === 'admin' || user?.id === c.ownerId;
  const task = c.activeTask;
  const pendingTask = isPendingAgentTaskStatus(task?.status) ? task : null;
  const runtimeLabel = task
    ? taskStatusLabel(task.status)
    : c.runtime.bound
    ? (c.runtime.status ?? ContainerStatus.Unknown)
    : 'unbound';
  const runtimeBadgeVariant = task ? taskVariant(task.status) : running ? 'success' : 'secondary';
  const containerStateLabel = pendingTask
    ? '任务处理中'
    : task
    ? `任务${taskStatusLabel(task.status)}`
    : c.runtime.bound
    ? (c.runtime.status ?? ContainerStatus.Unknown)
    : '未绑定';
  const ip = c.runtime.ip ?? '等待运行态';
  const sshLabel = c.ssh.ready ? '代理可用' : c.ssh.enabled ? c.ssh.status : '镜像禁用';
  const taskState = task
    ? TASK_KIND_LABELS[task.kind] ?? task.kind
    : null;
  const taskFailure = taskErrorMessage(task);
  const failureInfo = c.failureReason?.trim()
    ? c.failureReason
    : taskFailure
    ? taskFailure
    : c.failureCode ?? null;
  const sshCommand = c.ssh.login?.omittedServer ?? c.ssh.login?.explicitServer;
  const sshInfo = c.ssh.lastError
    ? c.ssh.lastError
    : c.ssh.ready && sshCommand && c.ssh.proxyHost && c.ssh.proxyPort
    ? `ssh ${sshCommand}@${c.ssh.proxyHost} -p ${c.ssh.proxyPort}`
    : c.ssh.enabled
    ? 'SSH 代理路由尚不可用'
    : '镜像已禁用 SSH';
  const runtimeMetricId = c.runtime.runtimeId?.slice(0, 12);
  const containerMetrics = metricsData?.containers.find((metrics) => (
    metrics.containerId === c.id
    || metrics.containerId === runtimeMetricId
    || metrics.name === c.name
  ));
  const hasGpuChart = c.resources.gpuIndices.length > 0 || hasSeriesData(containerMetrics?.gpuMemUsed);
  const gpuMemSeries = containerMetrics
    ? zeroFillSeriesFromReferences(containerMetrics.gpuMemUsed, [containerMetrics.cpu, containerMetrics.memUsed])
    : null;

  return (
    <div className="px-4 py-4 md:px-6 space-y-5 w-full">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-3">
          <Link to={backTo}><Button variant="outline" size="icon" className="h-8 w-8"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{c.name}</h1>
              {plane === 'admin' && c.ownerName && (
                <Badge variant="outline">{c.ownerName}</Badge>
              )}
              <Badge variant={runtimeBadgeVariant} title={taskBadgeTitle(task)}>
                {pendingTask && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                {runtimeLabel}
              </Badge>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant={activeTab === 'overview' ? 'default' : 'outline'} size="sm" onClick={() => setActiveTab('overview')}><BarChart2 className="h-4 w-4" />概览</Button>
          <Button variant={activeTab === 'console' ? 'default' : 'outline'} size="sm" disabled={!c.actions.console.enabled} title={actionTitle(c, 'console')} onClick={() => setActiveTab('console')}><Terminal className="h-4 w-4" />控制台</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={runAction.isPending}>
                <Power className="h-4 w-4" />
                电源
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              {(['start', 'stop', 'restart'] as ContainerAction[]).map((action) => (
                <DropdownMenuItem
                  key={action}
                  disabled={!c.actions[action].enabled || runAction.isPending}
                  title={actionTitle(c, action)}
                  onSelect={() => runAction.mutate(action)}
                >
                  {ACTION_LABELS[action]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="destructive"
            size="sm"
            disabled={!c.actions.delete.enabled || runAction.isPending}
            title={actionTitle(c, 'delete')}
            onClick={() => setDeleteConfirmOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            删除
          </Button>
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card rounded-lg border p-4">
            <h3 className="text-sm font-semibold text-foreground mb-3">容器信息</h3>
            <div className="space-y-2">
              {[
                ['镜像', c.imageName ?? c.imageId],
                ['服务器', c.serverName],
                ['IP', ip],
                ['CPU', formatCpu(c.resources.cpuMillis)],
                ['内存', formatBytesLimit(c.resources.memBytes)],
                ['GPU', c.resources.gpuIndices.length > 0 ? `索引 ${c.resources.gpuIndices.join(', ')}` : '—'],
              ].map(([k, v]) => <div key={k} className="flex justify-between py-1.5 text-sm border-b border-border/50 last:border-0"><span className="text-muted-foreground">{k}</span><span className="text-foreground font-medium text-right max-w-[60%] truncate" title={v}>{v}</span></div>)}
              <div className="flex items-center justify-between gap-3 py-1.5 text-sm border-b border-border/50 last:border-0">
                <span className="text-muted-foreground">容器状态</span>
                <div className="flex min-w-0 items-center justify-end gap-2">
                  <span className="text-foreground font-medium text-right truncate">{containerStateLabel}</span>
                  {taskState && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="当前任务"
                          >
                            {pendingTask && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{taskState}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {failureInfo && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-destructive transition-colors hover:text-destructive/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="失败信息"
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="max-w-xs break-words">{failureInfo}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </div>
              {(c.ssh.enabled || canManageContainer) && (
                <div className="flex items-center justify-between gap-3 py-1.5 text-sm border-b border-border/50 last:border-0">
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <span>SSH</span>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="SSH 信息"
                          >
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="break-all font-mono">{sshInfo}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="flex min-w-0 items-center justify-end gap-2">
                    <Badge variant={c.ssh.ready ? 'success' : c.ssh.enabled ? 'secondary' : 'outline'}>
                      {sshLabel}
                    </Badge>
                    {canManageContainer && c.ssh.enabled && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 py-0 text-xs"
                        disabled={!c.actions.reconcileSsh.enabled || runAction.isPending}
                        title={actionTitle(c, 'reconcileSsh')}
                        onClick={() => runAction.mutate('reconcileSsh')}
                      >
                        修复 SSH
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-card rounded-lg border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">容器指标</h3>
              <TimeRangeSelector value={metricsRange} onChange={setMetricsRange} />
            </div>
            {metricsLoading ? (
              <div className="h-[340px] animate-pulse rounded bg-muted/40" />
            ) : !canViewMetrics ? (
              <EmptyChart title="无指标权限" />
            ) : metricsError || !containerMetrics ? (
              <EmptyChart title="容器指标" />
            ) : (
              <div className={hasGpuChart ? 'space-y-4' : 'grid grid-cols-1 gap-4'}>
                <div className={hasGpuChart ? 'grid grid-cols-1 xl:grid-cols-2 gap-4' : 'space-y-4'}>
                  <InlineSingleLineChart title="CPU 用量（核心数）" series={containerMetrics.cpu} yFormatter={(v) => v.toFixed(2)} />
                  <InlineSingleLineChart title="内存用量" series={containerMetrics.memUsed} yFormatter={formatBytesCompact} />
                </div>
                {hasGpuChart && (
                  <InlineSingleLineChart title="GPU 显存" series={gpuMemSeries!} yFormatter={formatBytesCompact} height={170} />
                )}
              </div>
            )}
          </div>

          <MountsCard
            serverId={c.serverId}
            containerId={containerId}
            isRunning={c.actions.updateMounts.enabled}
            readonly={plane === 'admin'}
            apiBasePath={apiBasePath}
            plane={plane}
          />
        </div>
      )}

      {activeTab === 'console' && (
        <ContainerConsole container={c} apiBasePath={apiBasePath} />
      )}

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除容器？</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除容器 &ldquo;{c.name}&rdquo;？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={runAction.isPending}
              onClick={() => {
                setDeleteConfirmOpen(false);
                runAction.mutate('delete');
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function hasSeriesData(series: ContainerMetrics['gpuMemUsed'] | undefined): boolean {
  return Boolean(series?.points.some((point) => point.v !== null && Number.isFinite(point.v) && point.v > 0));
}
