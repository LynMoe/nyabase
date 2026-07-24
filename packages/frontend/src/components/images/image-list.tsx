import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Download, ImageIcon, Loader2, Pencil, Plus, RefreshCw, Trash2,
} from 'lucide-react';
import { AgentTaskStatus, type AdminImageDto } from '@nyabase/common';

import { queryKeys } from '../../lib/query-keys.js';
import { api } from '../../lib/api.js';
import { toast } from '../../hooks/use-toast.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '../ui/card.js';
import { Separator } from '../ui/separator.js';

import type { ImageTaskStatusDto, ServerStatus } from './types.js';
import { ServerStatusRow } from './pull-progress-dialog.js';
import {
  relevantImageLifecycleTask,
  summarizeImageLifecycle,
} from '../../lib/image-lifecycle-ui.js';
import { useRequesterAgentTaskBatchFeedback } from '../../hooks/use-agent-task-tracker.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { createResourceMutationGate } from '../../lib/resource-mutation-gate.js';
import { normalizeImageRuntimeOverridesForUi } from '../../lib/image-form-payload.js';

interface ImagePullResponse {
  tasks: Array<{ serverId: string; taskId: string; status: AgentTaskStatus }>;
  rejected: Array<{ serverId: string; message: string }>;
}

interface ImageListProps {
  images: AdminImageDto[];
  isLoading: boolean;
  onCreate: () => void;
  onEdit: (image: AdminImageDto) => void;
  onDelete: (image: AdminImageDto) => void;
}

export function ImageList({ images, isLoading, onCreate, onEdit, onDelete }: ImageListProps) {
  const qc = useQueryClient();
  const gate = useRef(createResourceMutationGate());
  const [pendingToggleIds, setPendingToggleIds] = useState<ReadonlySet<string>>(new Set());
  const toggle = useMutation({
    mutationFn: ({ id, isActive, expectedRevision }: {
      id: string;
      isActive: boolean;
      expectedRevision: number;
    }) => api.patch(`/admin/images/${id}`, { isActive, expectedRevision }),
    onError: (error) => toast({
      title: '镜像启停失败',
      description: error instanceof Error ? error.message : '请稍后重试',
      variant: 'destructive',
    }),
    onSettled: (_data, _error, variables) => {
      gate.current.end(variables.id);
      setPendingToggleIds(gate.current.snapshot());
      void qc.invalidateQueries({ queryKey: queryKeys.images.admin });
    },
  });
  const toggleImage = (image: AdminImageDto) => {
    if (!gate.current.begin(image.id)) return;
    setPendingToggleIds(gate.current.snapshot());
    toggle.mutate({ id: image.id, isActive: !image.isActive, expectedRevision: image.revision });
  };

  if (isLoading) {
    return <Card><CardContent className="h-32 animate-pulse bg-muted/50 rounded-lg mt-6" /></Card>;
  }

  if (images.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 space-y-3">
          <ImageIcon className="h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">还没有预置镜像</p>
          <Button size="sm" onClick={onCreate}>
            <Plus className="h-4 w-4" />添加镜像
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {images.map((img) => (
        <ImageCard
          key={img.id}
          image={img}
          togglePending={pendingToggleIds.has(img.id)}
          onToggle={() => toggleImage(img)}
          onEdit={() => onEdit(img)}
          onDelete={() => onDelete(img)}
        />
      ))}
    </div>
  );
}

interface ImageCardProps {
  image: AdminImageDto;
  onToggle: () => void;
  togglePending: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

function ImageCard({ image, onToggle, togglePending, onEdit, onDelete }: ImageCardProps) {
  const runtimeOverrides = normalizeImageRuntimeOverridesForUi(image.runtimeOverrides);
  const [expanded, setExpanded] = useState(image.deleting);
  const [taskIdsByServer, setTaskIdsByServer] = useState<Record<string, string>>({});
  useEffect(() => {
    if (image.deleting) {
      setExpanded(true);
      setTaskIdsByServer({});
    }
  }, [image.deleting]);

  const {
    data: fetchedStatuses = [], refetch, isPending: statusPending, isError: statusError,
  } = useQuery({
    queryKey: queryKeys.images.status(image.id),
    queryFn: () => api.get<ServerStatus[]>(`/admin/images/${image.id}/status`),
    enabled: expanded,
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: expanded ? 2_000 : false,
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
  });

  const taskEntries = Object.entries(taskIdsByServer);
  const taskTracker = useRequesterAgentTaskBatchFeedback(taskEntries.map(([, taskId]) => taskId), {
    invalidateQueryKeys: [queryKeys.images.admin, queryKeys.images.status(image.id)],
  });
  const tasksById = new Map(taskTracker.tasks.map((task) => [task.id, task]));
  const taskByServer = new Map<string, ImageTaskStatusDto>();
  taskEntries.forEach(([serverId, taskId]) => {
    const task = tasksById.get(taskId);
    if (task) taskByServer.set(serverId, task as ImageTaskStatusDto);
  });
  const statuses = fetchedStatuses.map((status) => {
    const task = relevantImageLifecycleTask(
      image.deleting,
      taskByServer.get(status.serverId) ?? status.task,
    );
    return { ...status, task };
  });

  const pullAll = useMutation({
    mutationFn: (serverIds?: string[]) =>
      api.post<ImagePullResponse>(
        `/admin/images/${image.id}/pull`,
        { serverIds },
      ),
    onSuccess: (res) => {
      if (res.tasks.length > 0) {
        setTaskIdsByServer((current) => ({
          ...current,
          ...Object.fromEntries(res.tasks.map((task) => [task.serverId, task.taskId])),
        }));
        toast({ title: `已创建 ${res.tasks.length} 个 Pull 任务` });
      }
      if (res.rejected.length > 0) {
        toast({
          title: `${res.rejected.length} 个 Pull 任务未创建`,
          description: res.rejected.map((item) => item.message).join('; '),
          variant: 'destructive',
        });
      }
      void refetch();
    },
    onError: (e) => toast({ title: 'Pull 失败', description: e.message, variant: 'destructive' }),
  });

  const onlineServers = statuses.filter((s) => s.online);
  const presentCount = statuses.filter((s) => s.present).length;
  const lifecycle = summarizeImageLifecycle(image.deleting, statuses.map((status) => status.task));
  const pullingCount = lifecycle.pendingCount;
  const failedCleanupCount = image.deleting ? lifecycle.failedCount : 0;
  const canRetryCleanup = lifecycle.canRetryCleanup;
  const canPullAll = !image.deleting && expanded && onlineServers.length > 0;

  return (
    <Card>
      <CardHeader className="p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="min-w-0 truncate text-base leading-6">{image.name}</CardTitle>
                {image.deleting ? (
                  <Badge variant="destructive" className="text-xs">删除清理中</Badge>
                ) : (
                  <Badge
                    variant={image.isActive ? 'success' : 'secondary'}
                    className={`${togglePending ? 'cursor-wait opacity-60' : 'cursor-pointer'} text-xs`}
                    aria-disabled={togglePending}
                    onClick={() => { if (!togglePending) onToggle(); }}
                  >
                    {togglePending ? '更新中' : image.isActive ? '启用' : '停用'}
                  </Badge>
                )}
              </div>
              <CardDescription className="mt-1 break-all font-mono text-xs">{image.dockerImage}</CardDescription>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>UID: <code className="rounded bg-muted px-1 py-0.5">{runtimeOverrides.uid}</code></span>
              {runtimeOverrides.entrypoint && (
                <span className="min-w-0 break-all">Entrypoint: <code className="rounded bg-muted px-1 py-0.5">{runtimeOverrides.entrypoint.join(' ')}</code></span>
              )}
              {runtimeOverrides.cmd && (
                <span className="min-w-0 break-all">CMD: <code className="rounded bg-muted px-1 py-0.5">{runtimeOverrides.cmd.join(' ')}</code></span>
              )}
              {runtimeOverrides.init && <span>启用 init</span>}
              {image.description && <span className="min-w-0 break-words">{image.description}</span>}
            </div>
          </div>

            <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
            {expanded && statuses.length > 0 && (
              <div className="flex h-8 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground">
                <CheckCircle className="h-3.5 w-3.5 text-green-500" />
                <span>{presentCount}/{statuses.length}</span>
                {pullingCount > 0 && (
                  <span className="flex items-center gap-0.5 text-blue-500">
                    <Loader2 className="h-3 w-3 animate-spin" />{pullingCount}
                  </span>
                )}
              </div>
            )}

            <Button
              variant="outline" size="sm"
              onClick={() => { setExpanded(!expanded); if (!expanded) refetch(); }}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {expanded ? '收起' : '展开详情'}
            </Button>

            {image.deleting ? (
              <Button variant="outline" size="sm" onClick={onDelete} disabled={!canRetryCleanup}
                title={canRetryCleanup ? '重新排队失败的镜像清理' : '仅在清理任务失败后可重试'}>
                <RefreshCw className="h-4 w-4" />重试清理
              </Button>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={onEdit} title="编辑镜像参数">
                  <Pencil className="h-4 w-4" />编辑
                </Button>
                <Button variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive"
                  onClick={onDelete} title="删除镜像">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </div>
      </CardHeader>

      {expanded && (
        <>
          <Separator />
          <CardContent className="space-y-3 p-4">
            {image.deleting && (
              <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  镜像仍在清理中，编辑、启停和 Pull 已禁用。
                  {failedCleanupCount > 0 ? ` ${failedCleanupCount} 个清理任务失败，可点击“重试清理”。` : ' 全部任务成功后该行会自动消失。'}
                </span>
              </div>
            )}
            {statusError ? (
              <p className="text-sm text-destructive text-center py-4">
                加载服务器状态失败，请检查权限或稍后重试
              </p>
            ) : statusPending ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                正在加载服务器状态...
              </p>
            ) : statuses.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                暂无服务器连接此系统
              </p>
            ) : (
              <>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    已加载 {statuses.length} 台服务器，在线 {onlineServers.length} 台。
                  </p>
                  <Button
                    size="sm"
                    disabled={!canPullAll || pullAll.isPending || pullingCount > 0}
                    onClick={() => pullAll.mutate(undefined)}
                  >
                    {pullAll.isPending || pullingCount > 0 ? (
                      <><Loader2 className="h-4 w-4 animate-spin" />Pull 中...</>
                    ) : (
                      <><Download className="h-4 w-4" />Pull 全部在线服务器</>
                    )}
                  </Button>
                </div>
                <div className="divide-y divide-border rounded-md border border-border bg-background">
                  {statuses.map((s) => (
                    <ServerStatusRow
                      key={s.serverId}
                      status={s}
                      onPull={() => pullAll.mutate([s.serverId])}
                      pulling={pullAll.isPending || pullingCount > 0}
                      mode={image.deleting ? 'delete' : 'pull'}
                    />
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </>
      )}
    </Card>
  );
}
