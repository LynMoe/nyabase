import { Link, getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, BarChart2, ChevronDown, Info, Loader2, Power, Terminal, Trash2 } from 'lucide-react';
import { ContainerStatus, type ContainerAction, type ContainerMetrics, type ContainerMetricsDto, type ContainerView, type OperationRefResponse } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { formatBytesCompact, formatBytesLimit, formatCpu } from '../lib/utils.js';
import { useAuthStore } from '../store/auth.js';
import { MountsCard } from '../components/containers/mounts-card.js';
import { toast } from '../hooks/use-toast.js';
import { useOperationTracker } from '../hooks/use-operation-tracker.js';
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
  EmptyChart,
  InlineSingleLineChart,
  TimeRangeSelector,
  zeroFillSeriesFromReferences,
} from '../components/dashboard/server-metrics.js';

const routeApi = getRouteApi('/containers/$containerId');

function actionTitle(container: ContainerView, action: ContainerAction): string | undefined {
  const availability = container.actions[action];
  return availability.enabled ? undefined : availability.message ?? availability.reason;
}

const ACTION_LABELS: Partial<Record<ContainerAction, string>> = {
  start: '启动',
  stop: '停止',
  restart: '重启',
  delete: '删除',
  enableSsh: '启用 SSH',
  reconcileSsh: '修复 SSH',
};

const OPERATION_STATE_LABELS: Record<string, string> = {
  'container.create': 'creating',
  'container.start': 'starting',
  'container.stop': 'stopping',
  'container.restart': 'restarting',
  'container.delete': 'deleting',
  'container.update_mounts': 'updating mounts',
  'container.enable_ssh': 'enabling SSH',
  'container.reconcile_ssh': 'reconciling SSH',
};

export default function ContainerDetailPage() {
  const { containerId } = routeApi.useParams();
  const { tab: initialTab } = routeApi.useSearch();
  const qc = useQueryClient();
  const { user } = useAuthStore();
  const [activeTab, setActiveTab] = useState<'overview' | 'console'>(initialTab);
  const [metricsRange, setMetricsRange] = useState('1h');
  const [trackedOperationId, setTrackedOperationId] = useState<string | null>(null);
  useOperationTracker(trackedOperationId);

  const { data: c } = useQuery({
    queryKey: queryKeys.containers.detail('user', containerId),
    queryFn: () => api.get<ContainerView>(`/v2/containers/${containerId}`),
    refetchInterval: 5_000,
  });

  const { data: metricsData, isLoading: metricsLoading, isError: metricsError } = useQuery({
    queryKey: ['metrics-container-detail', c?.serverId, containerId, c?.runtime.runtimeId, metricsRange],
    queryFn: () => api.get<ContainerMetricsDto>(`/metrics/servers/${c!.serverId}/containers?range=${metricsRange}`),
    enabled: activeTab === 'overview' && Boolean(c?.serverId),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });

  const runAction = useMutation({
    mutationFn: (action: ContainerAction) => api.post<OperationRefResponse>(`/v2/containers/${containerId}/actions/${containerActionPath(action)}`),
    onSuccess: (res) => {
      setTrackedOperationId(res.operationId);
      toast({ title: '操作已排队', description: `操作 ${res.operationId.slice(0, 8)}` });
      void qc.invalidateQueries({ queryKey: queryKeys.containers.detail('user', containerId) });
      void qc.invalidateQueries({ queryKey: queryKeys.containers.userList });
    },
    onError: (e) => toast({ title: '操作失败', description: (e as Error).message, variant: 'destructive' }),
  });

  if (!c) return <div className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />加载中...</div>;

  const running = c.runtime.status === ContainerStatus.Running;
  const canManageContainer = user?.id === c.ownerId;
  const runtimeLabel = c.runtime.bound ? (c.runtime.status ?? ContainerStatus.Unknown) : 'unbound';
  const ip = c.runtime.ip ?? '等待运行态';
  const sshLabel = c.ssh.status === 'running' ? '可用' : c.ssh.enabled ? c.ssh.status : '未启用';
  const operationState = c.activeOperation
    ? OPERATION_STATE_LABELS[c.activeOperation.kind] ?? c.activeOperation.kind
    : null;
  const failureInfo = c.failureReason?.trim()
    ? c.failureReason
    : c.failureCode ?? null;
  const sshInfo = c.ssh.lastError
    ? c.ssh.lastError
    : c.ssh.enabled && c.ssh.status === 'running' && c.runtime.ip
    ? `ssh root@${c.runtime.ip}`
    : c.ssh.enabled
    ? 'Dropbear SSH 服务尚不可用'
    : '启用后使用 root 和用户中心公钥连接';
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
    <div className="p-6 space-y-4 w-full">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-3">
          <Link to="/containers"><Button variant="outline" size="icon" className="h-8 w-8"><ArrowLeft className="h-4 w-4" /></Button></Link>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">{c.name}</h1>
              <Badge variant={running ? 'success' : 'secondary'}>{runtimeLabel}</Badge>
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
            onClick={() => runAction.mutate('delete')}
          >
            <Trash2 className="h-4 w-4" />
            删除
          </Button>
        </div>
      </div>

      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-card rounded-xl border p-4">
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
                  <span className="text-foreground font-medium text-right truncate">{c.phase}</span>
                  {operationState && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label="当前操作"
                          >
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            <Info className="h-3.5 w-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{operationState}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  {failureInfo && !operationState && (
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
                    <Badge variant={c.ssh.status === 'running' ? 'success' : c.ssh.enabled ? 'secondary' : 'outline'}>
                      {sshLabel}
                    </Badge>
                    {canManageContainer && !c.ssh.enabled && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 py-0 text-xs"
                        disabled={!c.actions.enableSsh.enabled || runAction.isPending}
                        title={actionTitle(c, 'enableSsh')}
                        onClick={() => runAction.mutate('enableSsh')}
                      >
                        启用
                      </Button>
                    )}
                    {canManageContainer && c.ssh.enabled && (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto px-0 py-0 text-xs"
                        disabled={!c.actions.reconcileSsh.enabled || runAction.isPending}
                        title={actionTitle(c, 'reconcileSsh')}
                        onClick={() => runAction.mutate('reconcileSsh')}
                      >
                        修复
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-card rounded-xl border p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">容器指标</h3>
              <TimeRangeSelector value={metricsRange} onChange={setMetricsRange} />
            </div>
            {metricsLoading ? (
              <div className="h-[340px] animate-pulse rounded bg-muted/40" />
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

          <MountsCard serverId={c.serverId} containerId={containerId} isRunning={c.actions.updateMounts.enabled} />
        </div>
      )}

      {activeTab === 'console' && (
        <ContainerConsole container={c} />
      )}
    </div>
  );
}

function hasSeriesData(series: ContainerMetrics['gpuMemUsed'] | undefined): boolean {
  return Boolean(series?.points.some((point) => point.v !== null && Number.isFinite(point.v) && point.v > 0));
}
