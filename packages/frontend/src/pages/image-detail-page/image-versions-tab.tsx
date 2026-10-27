import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { AdminImageDto, ImageVersionDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { lifecyclePhaseLabel } from '../../lib/display-labels.js';
import { relativeTime } from '../../lib/utils.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { TechnicalId, shortFingerprint } from '../../components/refs/technical-id.js';
import { Button } from '../../components/ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';

/**
 * Every version of the image. A repull makes the new one current; containers
 * created earlier keep theirs, and a version nothing uses any more can be
 * deleted, which removes its copy from the servers.
 */
export function ImageVersionsTab({ image }: { image: AdminImageDto }) {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<ImageVersionDto | null>(null);
  const versions = useQuery({
    queryKey: queryKeys.images.versions(image.id),
    queryFn: () => api.get<ImageVersionDto[]>(`/images/${image.id}/versions`),
  });
  const remove = useMutation({
    mutationFn: (fingerprint: string) =>
      api.delete<{ deleted: true }>(`/images/${image.id}/versions/${fingerprint}`),
    onSuccess: () => {
      toast({ title: '已删除版本', description: '各服务器会在下一次扫描时移除它的副本' });
      setDeleting(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.images.versions(image.id) });
    },
    onError: (error) => toast({ title: '删除版本失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const rows = versions.data ?? [];
  return (
    <SectionCard
      title="版本"
      flush={rows.length > 0}
      testId="image-versions"
    >
      {versions.isLoading ? (
        <p className="text-sm text-muted-foreground">加载版本...</p>
      ) : versions.isError ? (
        <p className="text-sm text-destructive">版本加载失败：{errorMessage(versions.error)}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无版本</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>版本</TableHead>
              <TableHead>指纹</TableHead>
              <TableHead>拉取于</TableHead>
              <TableHead>使用中的容器</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((version) => (
              <VersionRow
                key={version.fingerprint}
                version={version}
                busy={remove.isPending}
                onDelete={() => setDeleting(version)}
              />
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title="删除这个版本？"
        description={deleting
          ? `删除 ${deleting.description ?? shortFingerprint(deleting.fingerprint)} 后，无法再用它创建或重建容器。`
          : ''}
        confirmLabel="确认删除"
        pendingLabel="提交中..."
        pending={remove.isPending}
        onConfirm={() => { if (deleting) remove.mutate(deleting.fingerprint); }}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
      />
    </SectionCard>
  );
}

function VersionRow({
  version,
  busy,
  onDelete,
}: {
  version: ImageVersionDto;
  busy: boolean;
  onDelete: () => void;
}) {
  return (
    <TableRow data-testid="image-version-row">
      <TableCell className="whitespace-normal">
        <div className="flex flex-wrap items-center gap-2">
          <span>{version.description ?? '未记录'}</span>
          {version.current ? <StatusBadge label="当前" pending={false} variant="success" /> : null}
        </div>
      </TableCell>
      <TableCell>
        <TechnicalId label="指纹" value={version.fingerprint} kind="fingerprint" />
      </TableCell>
      <TableCell>{version.createdAt ? relativeTime(version.createdAt) : '—'}</TableCell>
      <TableCell className="whitespace-normal">
        {version.containers.length === 0 ? (
          <span className="text-sm text-muted-foreground">无</span>
        ) : (
          <ul className="space-y-1 text-sm">
            {version.containers.map((container) => (
              <li key={container.id} className="flex flex-wrap items-center gap-x-2">
                <ResourceRef kind="container" id={container.id} name={container.name} />
                <span className="text-xs text-muted-foreground">
                  {container.ownerName} · {container.serverName}
                  {container.lifecyclePhase === 'active' ? '' : ` · ${lifecyclePhaseLabel(container.lifecyclePhase)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </TableCell>
      <TableCell className="text-right">
        {version.deletable ? (
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>
            <Trash2 className="h-3.5 w-3.5" />删除
          </Button>
        ) : (
          <span
            className="text-xs text-muted-foreground"
            title={version.current ? '新建容器使用当前版本' : '仍有容器使用这个版本'}
          >
            {version.current ? '当前版本' : '使用中'}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}
