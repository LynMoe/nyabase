import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Database, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { VolumeDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { ResourceGrid } from '../components/layout/resource-grid.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { LocalVolumeFormDialog } from '../components/storage/local-volume-form-dialog.js';
import { approxGibHint, relativeTime } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import {
  failureCodeLabel,
  volumeAttentionHint,
  volumeLifecycleLabel,
} from '../lib/status-labels.js';
import { ResourceIntentFailures } from '../components/intents/resource-intent-failures.js';

export default function VolumesPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<VolumeDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VolumeDto | null>(null);
  const volumesQuery = useQuery({
    queryKey: queryKeys.volumes.user,
    queryFn: () => api.get<VolumeDto[]>('/volumes'),
  });
  const deleteVolume = useMutation({
    mutationFn: (volumeId: string) => api.delete<unknown>(`/volumes/${volumeId}`),
    onSuccess: () => {
      toast({
        title: '删除已提交',
        description: '列表状态稍后更新；若出现「需要关注」，请查看卡片上的说明。',
      });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.volumes.user });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="volumes">
      <PageHeader
        title="数据卷"
        description="服务器本地盘。共享卷请到「共享卷」。扩缩容是否需先卸载，取决于所选存储池的能力。"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void volumesQuery.refetch(); }} aria-label="刷新数据卷">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建数据卷</Button>
          </>
        }
      />
      <QueryView
        query={volumesQuery}
        resourceName="数据卷"
        loadingLabel="加载数据卷..."
        showEmpty={volumesQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无本地数据卷。创建后即可挂载到容器。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />新建数据卷</Button>}
          />
        }
      >
        {(volumes) => (
          <ResourceGrid>
            {volumes.map((volume) => (
              <VolumeCard key={volume.id} volume={volume} onEdit={() => setEditTarget(volume)} onDelete={() => setDeleteTarget(volume)} />
            ))}
          </ResourceGrid>
        )}
      </QueryView>
      <LocalVolumeFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <LocalVolumeFormDialog
          volume={editTarget}
          open
          onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除数据卷？"
        description={
          <>
            <p>将删除「{deleteTarget?.name}」。</p>
            <p className="mt-2">若该卷仍挂载在容器上，删除会被拒绝。请先卸载后再试。</p>
          </>
        }
        confirmLabel="确认删除"
        pendingLabel="提交中..."
        pending={deleteVolume.isPending}
        onConfirm={() => { if (deleteTarget) deleteVolume.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}

function VolumeCard({ volume, onEdit, onDelete }: { volume: VolumeDto; onEdit: () => void; onDelete: () => void }) {
  const shrinkLabel = volume.capability.shrinkNever
    ? '不可缩容'
    : volume.capability.shrinkRequiresStop
      ? '缩容需卸载'
      : volume.capability.shrinkOnline
        ? '可在线缩容'
        : '缩容受用量约束';
  const phaseLabel = volume.needsAttention
    ? '需要关注'
    : volumeLifecycleLabel(volume.lifecyclePhase);
  const codeLabel = failureCodeLabel(volume.failureCode);
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <Database className="h-4 w-4 shrink-0" />
            <span className="truncate">{volume.name}</span>
          </CardTitle>
          <Badge variant={volume.needsAttention ? 'destructive' : volume.lifecyclePhase === 'active' ? 'success' : 'secondary'}>
            {phaseLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Info label="范围" value={`本地服务器 ${volume.serverId}`} />
          <Info label="存储池" value={volume.poolName} />
          <Info label="容量" value={`${approxGibHint(volume.sizeBytes).replace(/^约 /, '')} · 已用 ${volume.usedBytes === null ? '未知' : approxGibHint(volume.usedBytes).replace(/^约 /, '')}`} />
          <Info label="缩容能力" value={shrinkLabel} />
          <Info label="实例名" value={volume.incusName} mono />
          <Info label="最近更新" value={relativeTime(volume.updatedAt)} />
        </div>
        {volume.needsAttention && (
          <p className="text-xs text-destructive">{volumeAttentionHint(volume.failureCode)}</p>
        )}
        {!volume.needsAttention && volume.failureCode && (
          <p className="break-all text-xs text-destructive">
            {codeLabel}
            {codeLabel !== volume.failureCode ? `（${volume.failureCode}）` : null}
          </p>
        )}
        <ResourceIntentFailures listPath={`/volumes/${volume.id}/intents`} admin={false} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          {volume.attachments.length === 0 ? (
            <p className="text-xs text-muted-foreground">请打开目标容器详情 → 存储 → 挂载</p>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="volume-attachments">
              挂载于 {volume.attachments.map((item) => `${item.containerName}（${item.containerPath}）`).join('、')}
            </p>
          )}
          <Button size="sm" variant="link" className="h-auto px-0" asChild>
            <Link to="/containers">到容器挂载</Link>
          </Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />编辑/扩缩</Button>
          <Button size="sm" variant="destructive" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" />删除</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={mono ? 'break-all font-mono text-xs' : 'break-all text-sm'}>{value}</p>
    </div>
  );
}
