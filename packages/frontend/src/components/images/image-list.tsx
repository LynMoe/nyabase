import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Fingerprint, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { AdminImageDto, ImageAssignmentDto, IntentAcceptedDto, ServerDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { formatBytes, relativeTime } from '../../lib/utils.js';
import { lifecyclePhaseLabel } from '../../lib/display-labels.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { ResourceIntentFailures } from '../intents/resource-intent-failures.js';

type AssignmentResponse = {
  assignment: ImageAssignmentDto;
  intent?: IntentAcceptedDto;
};

export function ImageList({
  images,
  onEdit,
  onDelete,
  onCreate,
}: {
  images: AdminImageDto[];
  onEdit: (image: AdminImageDto) => void;
  onDelete: (image: AdminImageDto) => void;
  onCreate?: () => void;
}) {
  const queryClient = useQueryClient();
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
  });
  const servers = serversQuery.data ?? [];
  const assign = useMutation({
    mutationFn: ({ imageId, serverId, expectedGeneration }: { imageId: string; serverId: string; expectedGeneration?: number }) =>
      api.put<AssignmentResponse>(`/admin/images/${imageId}/assignments/${serverId}`, expectedGeneration ? { expectedGeneration } : {}),
    onSuccess: (result) => {
      toast({ title: '镜像分配意图已创建', description: result.intent ? `意图 ${result.intent.intentId.slice(0, 8)}` : undefined });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
    },
    onError: (error) => toast({ title: '镜像分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const unassign = useMutation({
    mutationFn: ({ imageId, serverId, generation }: { imageId: string; serverId: string; generation: number }) =>
      api.delete<AssignmentResponse>(`/admin/images/${imageId}/assignments/${serverId}?expectedGeneration=${generation}`),
    onSuccess: () => {
      toast({ title: '镜像取消分配意图已创建' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
    },
    onError: (error) => toast({ title: '取消分配失败', description: errorMessage(error), variant: 'destructive' }),
  });

  if (images.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 py-12 text-center">
          <p className="text-sm text-muted-foreground">暂无镜像。</p>
          {onCreate && (
            <Button onClick={onCreate}><Plus className="h-4 w-4" />添加镜像</Button>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {images.map((image) => (
        <Card key={image.id} data-testid="image-fingerprint-assignment">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <CardTitle className="truncate text-base">{image.name}</CardTitle>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{image.alias}</p>
              </div>
              <Badge variant={image.isActive && !image.deleting ? 'success' : 'secondary'}>{image.deleting ? '清理中' : image.isActive ? '可用' : '停用'}</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <InfoRow label="当前指纹" value={image.fingerprint ?? '尚未收敛'} mono />
              <InfoRow label="最小系统盘容量" value={image.minRootSizeBytes === null ? '未设置' : formatBytes(image.minRootSizeBytes)} />
              <InfoRow label="登录用户" value={image.loginUser} mono />
              <InfoRow label="网络由平台管理" value={image.networkManagedExternally ? '是' : '否'} />
            </div>
            <ResourceIntentFailures listPath={`/admin/images/${image.id}/intents`} admin />
            <div className="rounded-md border">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="text-sm font-medium">服务器分配</span>
                <select
                  className="h-8 max-w-[220px] rounded-md border border-input bg-background px-2 text-xs"
                  value=""
                  onChange={(event) => {
                    if (event.target.value) assign.mutate({ imageId: image.id, serverId: event.target.value });
                  }}
                  disabled={assign.isPending || servers.length === 0 || image.deleting}
                  aria-label={`为 ${image.name} 分配服务器`}
                >
                  <option value="">添加服务器...</option>
                  {servers.filter((server) => !image.assignments.some((assignment) => assignment.serverId === server.id)).map((server) => (
                    <option key={server.id} value={server.id}>{server.name}</option>
                  ))}
                </select>
              </div>
              <div className="divide-y">
                {image.assignments.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-muted-foreground">尚未分配到服务器。</p>
                ) : image.assignments.map((assignment) => (
                  <AssignmentRow
                    key={assignment.id}
                    assignment={assignment}
                    serverName={servers.find((server) => server.id === assignment.serverId)?.name ?? assignment.serverId}
                    onEnsure={() => assign.mutate({ imageId: image.id, serverId: assignment.serverId, expectedGeneration: assignment.generation })}
                    onDelete={() => unassign.mutate({ imageId: image.id, serverId: assignment.serverId, generation: assignment.generation })}
                    busy={assign.isPending || unassign.isPending}
                  />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => onEdit(image)} disabled={image.deleting}>编辑</Button>
              <Button size="sm" variant="destructive" onClick={() => onDelete(image)}><Trash2 className="h-3.5 w-3.5" />删除</Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AssignmentRow({
  assignment,
  serverName,
  onEnsure,
  onDelete,
  busy,
}: {
  assignment: ImageAssignmentDto;
  serverName: string;
  onEnsure: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const ready = assignment.lifecyclePhase === 'active' && !assignment.needsAttention && assignment.managedFingerprint === assignment.observedFingerprint;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Server className="h-3.5 w-3.5 text-muted-foreground" />
          <span>{serverName}</span>
          <Badge variant={ready ? 'success' : assignment.needsAttention ? 'destructive' : 'warning'}>
            {ready ? <><Check className="h-3 w-3" />已同步</> : lifecyclePhaseLabel(assignment.lifecyclePhase)}
          </Badge>
        </div>
        <div className="mt-1 flex items-center gap-1 break-all font-mono text-[11px] text-muted-foreground">
          <Fingerprint className="h-3 w-3 shrink-0" />
          {assignment.observedFingerprint ?? assignment.managedFingerprint ?? '等待指纹'}
        </div>
        {assignment.failureReason && <div className="mt-1 flex items-center gap-1 text-xs text-destructive"><CircleAlert className="h-3 w-3" />{assignment.failureReason}</div>}
        {assignment.failureCode && !assignment.failureReason && (
          <div className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />{assignment.failureCode}
          </div>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">最近观测 {relativeTime(assignment.lastObservedAt)}</p>
      </div>
      <div className="flex gap-1">
        <Button size="sm" variant="outline" onClick={onEnsure} disabled={busy}><RefreshCw className="h-3.5 w-3.5" />重新收敛</Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>移除</Button>
      </div>
    </div>
  );
}

function InfoRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className={mono ? 'break-all font-mono text-xs' : 'text-sm'}>{value}</p></div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
