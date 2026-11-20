import { useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { StorageMountPreviewDto } from '@nyabase/common';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { parseMountPathInput, storageErrorMessage } from '../../lib/data-disks.js';
import { FormField } from '../layout/form-field.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Switch } from '../ui/switch.js';

/** What a disk-settings save sends: only the fields that changed. */
export interface DiskMountChange {
  mountPath?: string | null;
  maintenance?: boolean;
}

/** Long lists in the preview show this many names, then a count. */
const PREVIEW_LIST_LIMIT = 20;

/**
 * Mount path and maintenance of a disk (a local data pool or a shared
 * backend). Enabling it, or moving it to another path, first shows what the
 * server's preview says it will do; every change is reviewed before saving.
 */
export function DiskMountDialog({
  title,
  reach,
  current,
  unsupportedReason = null,
  previewPath,
  save,
  onSaved,
  onClose,
}: {
  title: string;
  /** Where the users' containers are: 这台服务器上 / 所有服务器上. */
  reach: string;
  current: { mountPath: string | null; maintenance: boolean };
  /** Why this disk cannot be enabled (pools only); null when it can. */
  unsupportedReason?: string | null;
  /** POST endpoint of the mount preview. */
  previewPath: string;
  save: (change: DiskMountChange) => Promise<unknown>;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [pathText, setPathText] = useState(current.mountPath ?? '');
  const [maintenance, setMaintenance] = useState(current.maintenance);
  const [review, setReview] = useState<{ preview: StorageMountPreviewDto | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseMountPathInput(pathText);
  const nextPath = parsed.ok ? parsed.value : undefined;
  const pathChanged = nextPath !== undefined && nextPath !== current.mountPath;
  const maintenanceChanged = maintenance !== current.maintenance;
  const enabling = pathChanged && nextPath !== null;
  const blocked = enabling && unsupportedReason !== null;
  const change: DiskMountChange = {
    ...(pathChanged ? { mountPath: nextPath } : {}),
    ...(maintenanceChanged ? { maintenance } : {}),
  };

  const preview = useMutation({
    mutationFn: (mountPath: string) => api.post<StorageMountPreviewDto>(previewPath, { mountPath }),
    onSuccess: (result) => setReview({ preview: result }),
    onError: (mutationError) => setError(storageErrorMessage(mutationError)),
  });
  const commit = useMutation({
    mutationFn: () => save(change),
    onSuccess: () => {
      toast({ title: '数据盘设置已保存' });
      onSaved();
      onClose();
    },
    onError: (mutationError) => {
      setError(storageErrorMessage(mutationError));
      setReview(null);
    },
  });
  const next = () => {
    setError(null);
    if (enabling) preview.mutate(nextPath);
    else setReview({ preview: null });
  };
  const pending = preview.isPending || commit.isPending;

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-2xl" data-testid="disk-mount-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            设置挂载点即启用：每个获得授权的用户在这块盘上自动得到一个卷，挂载到该路径，出现在他{reach}的所有容器里，容量随额度自动调整。留空为不启用。
          </DialogDescription>
        </DialogHeader>
        {review ? (
          <ReviewStep current={current} change={change} preview={review.preview} />
        ) : (
          <div className="space-y-4">
            <FormField
              id="disk-mount-path"
              label="挂载点"
              hint="容器内的绝对路径，例如 /data1。同一台服务器的本地盘与所有共享存储的挂载点不能相同或互相嵌套，也不能使用系统目录。"
              error={parsed.ok ? null : parsed.error}
            >
              <Input
                id="disk-mount-path"
                value={pathText}
                placeholder="不启用"
                onChange={(event) => { setPathText(event.target.value); setError(null); }}
              />
            </FormField>
            <FormField id="disk-maintenance" label="维护中" orientation="inline">
              <Switch id="disk-maintenance" checked={maintenance} onCheckedChange={setMaintenance} />
            </FormField>
            <p className="-mt-2 text-xs text-muted-foreground">
              维护中的盘不挂进任何容器（已挂载的会被卸下，容器照常运行），结束维护后自动挂回。
            </p>
            {blocked ? (
              <Alert variant="warning"><AlertDescription>{unsupportedReason}</AlertDescription></Alert>
            ) : null}
          </div>
        )}
        {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter>
          {review ? (
            <>
              <Button variant="outline" onClick={() => setReview(null)} disabled={pending}>返回修改</Button>
              <Button onClick={() => commit.mutate()} disabled={pending} data-testid="disk-mount-confirm">
                {commit.isPending ? '保存中...' : '确认保存'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={onClose} disabled={pending}>取消</Button>
              <Button
                onClick={next}
                disabled={pending || !parsed.ok || blocked || (!pathChanged && !maintenanceChanged)}
                data-testid="disk-mount-next"
              >
                {preview.isPending ? '预览中...' : '下一步'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The change in words, and what enabling at the new path does now. */
function ReviewStep({
  current,
  change,
  preview,
}: {
  current: { mountPath: string | null; maintenance: boolean };
  change: DiskMountChange;
  preview: StorageMountPreviewDto | null;
}) {
  const lines: string[] = [];
  if (change.mountPath !== undefined) {
    if (change.mountPath === null) {
      lines.push('停用这块盘：平台不再为用户建卷或新增挂载，已有的卷和挂载保留。');
    } else if (current.mountPath === null) {
      lines.push(`启用这块盘，挂载点 ${change.mountPath}。`);
    } else {
      lines.push(`挂载点从 ${current.mountPath} 改为 ${change.mountPath}：只影响之后的挂载，已在容器里的挂载保留原路径。`);
    }
  }
  if (change.maintenance === true) lines.push('进入维护：这块盘从所有容器卸下（容器不停机），结束维护后自动挂回。');
  if (change.maintenance === false) lines.push('结束维护：这块盘重新挂载到用户的容器。');
  return (
    <div className="space-y-3 text-sm" data-testid="disk-mount-review">
      {lines.map((line) => <p key={line}>{line}</p>)}
      {preview ? <MountPreview preview={preview} /> : null}
    </div>
  );
}

function MountPreview({ preview }: { preview: StorageMountPreviewDto }) {
  return (
    <div className="space-y-3 rounded-md border px-3 py-3" data-testid="disk-mount-preview">
      <PreviewList
        title={`将为 ${preview.volumes.length} 个用户各建一个卷`}
        empty="目前没有用户获得这块盘的授权，授权后才会建卷。"
        items={preview.volumes.map((row) => (
          <ResourceRef key={row.userId} kind="user" id={row.userId} username={row.username} />
        ))}
      />
      <PreviewList
        title={`将挂载到 ${preview.mounts.length} 个容器`}
        empty="目前没有需要挂载的容器。"
        items={preview.mounts.map((row) => (
          <ResourceRef key={row.containerId} kind="container" id={row.containerId} name={row.containerName} scope="all" />
        ))}
      />
      {preview.pathConflicts.length > 0 ? (
        <PreviewList
          title={`${preview.pathConflicts.length} 个容器在该路径已挂着别的卷，将跳过`}
          tone="warning"
          items={preview.pathConflicts.map((row) => (
            <ResourceRef key={row.containerId} kind="container" id={row.containerId} name={row.containerName} scope="all" />
          ))}
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        容器里该路径若已有文件，这块盘在该容器里暂不挂载，直到路径清空或移走后重启容器。
      </p>
    </div>
  );
}

function PreviewList({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: ReactNode[];
  empty?: string;
  tone?: 'warning';
}) {
  const shown = items.slice(0, PREVIEW_LIST_LIMIT);
  return (
    <div className="space-y-1">
      <p className={tone === 'warning' ? 'font-medium text-warning' : 'font-medium'}>{title}</p>
      {items.length === 0 ? (
        empty ? <p className="text-xs text-muted-foreground">{empty}</p> : null
      ) : (
        <p className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
          {shown.map((item, index) => <span key={index}>{item}</span>)}
          {items.length > shown.length ? <span className="text-muted-foreground">等 {items.length} 个</span> : null}
        </p>
      )}
    </div>
  );
}
