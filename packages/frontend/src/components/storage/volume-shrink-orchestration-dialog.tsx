import { useEffect, useState } from 'react';
import {
  type AttachVolumeRequest,
  FailureCode,
  type IntentAcceptedDto,
  IntentResourceType,
  type ListScope,
  type PatchVolumeRequest,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { ApiError, errorMessage } from '../../lib/api-error.js';
import { lookupLatestIntentFailure, resourceIntentsPath } from '../../lib/intent-visibility.js';
import {
  formatDetachProgress,
  parseVolumeShrinkAttachments,
  type VolumeShrinkAttachmentRef,
  waitUntil,
} from '../../lib/storage-shrink.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { formatBytes } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';

type ShrinkPhase = 'list' | 'detaching' | 'shrinking' | 'remount' | 'done' | 'failed';
type ShrinkFailureStage = 'load' | 'detach_partial' | 'shrink' | 'remount' | null;
type VolumeShrinkFlow = ReturnType<typeof useVolumeShrinkFlow>;

/** Shrinking an attached volume: unmount it everywhere, shrink, offer to mount it back. */
export function VolumeShrinkOrchestrationDialog({
  scope,
  volume,
  sizeBytes,
  open,
  onOpenChange,
  onComplete,
}: {
  scope: ListScope;
  volume: VolumeDto;
  sizeBytes: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const flow = useVolumeShrinkFlow({ scope, volume, sizeBytes, open, onComplete });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="volume-shrink-orchestration">
        <DialogHeader>
          <DialogTitle>缩容需要先卸载</DialogTitle>
          <DialogDescription>
            {flow.attachments.length} 处挂载 · 目标容量 {formatBytes(sizeBytes)}
          </DialogDescription>
        </DialogHeader>
        <ShrinkDialogBody flow={flow} />
        <ShrinkDialogFooter flow={flow} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

const attachmentLabel = (attachment: VolumeShrinkAttachmentRef) =>
  attachment.containerName?.trim() || attachment.containerId;

/** The attachment list, progress, error and the explanation of the current stage. */
function ShrinkDialogBody({ flow }: { flow: VolumeShrinkFlow }) {
  const { phase, failureStage, attachments, busy, progress, error, detached, shrinkSubmitted } = flow;
  return (
    <div className="space-y-3">
      {attachments.length === 0 && phase === 'list' && !busy ? (
        <p className="text-sm text-muted-foreground">没有挂载</p>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {attachments.map((attachment) => (
            <li key={attachment.attachmentId} className="px-3 py-2">
              <p className="text-sm">{attachmentLabel(attachment)}</p>
              <p className="font-mono text-xs text-muted-foreground">{attachment.containerPath}</p>
            </li>
          ))}
        </ul>
      )}
      {progress && <p className="text-sm text-muted-foreground" data-testid="volume-shrink-progress">{progress}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {phase === 'remount' && (
        <p className="text-sm">缩容已提交。是否将刚才卸载的挂载点挂回？</p>
      )}
      {phase === 'failed' && failureStage === 'detach_partial' && (
        <p className="text-sm text-muted-foreground">部分挂载已卸载</p>
      )}
      {phase === 'failed' && failureStage === 'remount' && (
        <p className="text-sm text-muted-foreground">挂回未完成</p>
      )}
      {phase === 'failed' && failureStage === 'shrink' && detached.length > 0 && (
        <p className="text-sm text-muted-foreground">缩容提交失败，挂载仍未挂回</p>
      )}
      {phase === 'done' && (
        <p className="text-sm text-muted-foreground">
          {shrinkSubmitted
            ? '缩容已提交，挂载已处理完毕。'
            : '已挂回；缩容未提交，容量未变。'}
        </p>
      )}
    </div>
  );
}

/** The buttons that fit the current stage. */
function ShrinkDialogFooter({
  flow,
  onClose,
}: {
  flow: VolumeShrinkFlow;
  onClose: () => void;
}) {
  const {
    phase,
    failureStage,
    attachments,
    busy,
    detached,
    pendingRemount,
    remainingAttachments,
    runDetachAndShrink,
    remount,
    reload,
    setPhase,
  } = flow;
  const toRemount = pendingRemount.length > 0 ? pendingRemount : detached;
  return (
    <DialogFooter className="flex-wrap gap-2">
      <Button variant="outline" onClick={onClose} disabled={busy}>关闭</Button>
      {phase === 'list' && (
        <Button
          onClick={() => { void runDetachAndShrink(attachments); }}
          disabled={busy}
        >
          {busy ? '执行中...' : attachments.length === 0 ? '提交缩容' : '一键卸载并缩容'}
        </Button>
      )}
      {phase === 'failed' && failureStage === 'load' && (
        <Button onClick={reload} disabled={busy}>
          {busy ? '加载中...' : '重新加载'}
        </Button>
      )}
      {phase === 'failed' && failureStage === 'detach_partial' && (
        <>
          {detached.length > 0 && (
            <Button
              variant="outline"
              onClick={() => { void remount(detached); }}
              disabled={busy}
            >
              {busy ? '挂回中...' : '挂回已成功项'}
            </Button>
          )}
          {remainingAttachments.length > 0 && (
            <Button
              onClick={() => { void runDetachAndShrink(remainingAttachments); }}
              disabled={busy}
            >
              {busy ? '执行中...' : '重试剩余卸载'}
            </Button>
          )}
        </>
      )}
      {phase === 'failed' && failureStage === 'shrink' && (
        <>
          {detached.length > 0 && (
            <Button
              variant="outline"
              onClick={() => { void remount(detached); }}
              disabled={busy}
            >
              {busy ? '挂回中...' : '挂回已卸载项'}
            </Button>
          )}
          <Button onClick={() => { void runDetachAndShrink([]); }} disabled={busy}>
            {busy ? '执行中...' : '重试缩容'}
          </Button>
        </>
      )}
      {phase === 'failed' && failureStage === 'remount' && (
        <Button onClick={() => { void remount(toRemount); }} disabled={busy}>
          {busy ? '挂回中...' : '重试挂回'}
        </Button>
      )}
      {phase === 'remount' && (
        <>
          <Button variant="outline" onClick={() => { setPhase('done'); onClose(); }} disabled={busy}>
            暂不挂回
          </Button>
          <Button onClick={() => { void remount(toRemount); }} disabled={busy}>
            {busy ? '挂回中...' : '挂回全部'}
          </Button>
        </>
      )}
    </DialogFooter>
  );
}

interface ShrinkState {
  phase: ShrinkPhase;
  failureStage: ShrinkFailureStage;
  attachments: VolumeShrinkAttachmentRef[];
  progress: string | null;
  error: string | null;
  detached: VolumeShrinkAttachmentRef[];
  pendingRemount: VolumeShrinkAttachmentRef[];
  busy: boolean;
  shrinkSubmitted: boolean;
}

/** What the workflow steps read, and how they report into the state. */
interface ShrinkContext {
  readonly scope: ListScope;
  readonly volume: VolumeDto;
  readonly sizeBytes: number;
  readonly attachments: VolumeShrinkAttachmentRef[];
  readonly patch: (change: Partial<ShrinkState>) => void;
}

/**
 * The shrink workflow for a volume that is still attached: unmount it from
 * every container, submit the shrink, then offer to mount it back. Failures
 * leave the dialog in a stage that says exactly what can be retried.
 */
function useVolumeShrinkFlow({
  scope,
  volume,
  sizeBytes,
  open,
  onComplete,
}: {
  scope: ListScope;
  volume: VolumeDto;
  sizeBytes: number;
  open: boolean;
  onComplete: () => void;
}) {
  const [state, setState] = useState<ShrinkState>({
    phase: 'list',
    failureStage: null,
    attachments: [],
    progress: null,
    error: null,
    detached: [],
    pendingRemount: [],
    busy: false,
    shrinkSubmitted: false,
  });
  const patch = (change: Partial<ShrinkState>) => setState((current) => ({ ...current, ...change }));
  const { attachments, detached, shrinkSubmitted } = state;
  const ctx: ShrinkContext = { scope, volume, sizeBytes, attachments, patch };

  /** Load the volume's attachments; on failure the dialog offers a reload. */
  const loadAttachments = async () => {
    try {
      patch({ attachments: await loadAttachmentsForVolume(scope, volume.id) });
      return true;
    } catch (loadError) {
      patch({ error: errorMessage(loadError), failureStage: 'load', phase: 'failed' });
      return false;
    } finally {
      patch({ busy: false });
    }
  };

  useEffect(() => {
    if (!open) return;
    patch({
      phase: 'list',
      failureStage: null,
      progress: null,
      error: null,
      detached: [],
      pendingRemount: [],
      shrinkSubmitted: false,
      busy: true,
    });
    void loadAttachments();
  }, [open, volume.id]);

  const reload = () => {
    patch({ busy: true, error: null });
    void loadAttachments().then((loaded) => {
      if (loaded) patch({ failureStage: null, phase: 'list' });
    });
  };

  const remainingAttachments = attachments.filter(
    (item) => !detached.some((done) => done.attachmentId === item.attachmentId),
  );

  const runDetachAndShrink = async (targets: VolumeShrinkAttachmentRef[]) => {
    patch({ busy: true, error: null, failureStage: null, phase: 'detaching' });
    const succeeded = [...detached];
    try {
      if (!await detachAll(ctx, targets, succeeded)) return;
      patch({ detached: succeeded, phase: 'shrinking', progress: '正在提交缩容…' });
      if (!await submitShrink(ctx, succeeded)) return;
      patch({
        pendingRemount: succeeded,
        shrinkSubmitted: true,
        phase: succeeded.length > 0 ? 'remount' : 'done',
        progress: null,
      });
      onComplete();
    } catch (runError) {
      patch({ error: errorMessage(runError), failureStage: 'shrink', phase: 'failed' });
    } finally {
      patch({ busy: false });
    }
  };

  const remount = async (targets: VolumeShrinkAttachmentRef[]) => {
    patch({ busy: true, error: null, progress: null });
    // Keep failureStage until remount fully succeeds so abort remounts stay honest.
    const abortingWithoutShrink = !shrinkSubmitted;
    try {
      patch({ phase: 'remount' });
      if (!await remountAll(ctx, [...targets])) return;
      patch({ pendingRemount: [], failureStage: null, phase: 'done' });
      if (!abortingWithoutShrink) onComplete();
    } finally {
      patch({ busy: false });
    }
  };

  return {
    ...state,
    remainingAttachments,
    setPhase: (phase: ShrinkPhase) => patch({ phase }),
    runDetachAndShrink,
    remount,
    reload,
  };
}

async function loadAttachmentsForVolume(scope: ListScope, volumeId: string): Promise<VolumeShrinkAttachmentRef[]> {
  const latest = await api.get<VolumeDto>(scopedPath(`/volumes/${volumeId}`, scope));
  return latest.attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    containerId: attachment.containerId,
    containerPath: attachment.containerPath,
    containerName: attachment.containerName,
  }));
}

/** Detach the targets one by one; false when one failed (the failure state is already set). */
async function detachAll(
  ctx: ShrinkContext,
  targets: VolumeShrinkAttachmentRef[],
  succeeded: VolumeShrinkAttachmentRef[],
): Promise<boolean> {
  const { scope, patch, attachments, volume } = ctx;
  for (let index = 0; index < targets.length; index += 1) {
    const attachment = targets[index]!;
    patch({ progress: formatDetachProgress(succeeded.length, attachments.length, null, null) });
    try {
      await api.delete<IntentAcceptedDto>(
        scopedPath(`/containers/${attachment.containerId}/volumes/${attachment.attachmentId}`, scope),
      );
      await waitUntil(async () => {
        const remaining = await loadAttachmentsForVolume(scope, volume.id);
        return !remaining.some((item) => item.attachmentId === attachment.attachmentId);
      }, {
        label: '等待卸载',
        timeoutMs: 90_000,
        onTimeout: () => lookupLatestIntentFailure(resourceIntentsPath(scope, IntentResourceType.Container, attachment.containerId)),
      });
      succeeded.push(attachment);
      patch({
        detached: [...succeeded],
        progress: formatDetachProgress(succeeded.length, attachments.length, null, null),
      });
    } catch (detachError) {
      const message = errorMessage(detachError);
      patch({
        progress: formatDetachProgress(succeeded.length, attachments.length, index, message),
        error: message,
        detached: succeeded,
        failureStage: 'detach_partial',
        phase: 'failed',
        busy: false,
      });
      return false;
    }
  }
  return true;
}

/** Submit the shrink and wait for it; false when it did not complete (state already set). */
async function submitShrink(
  ctx: ShrinkContext,
  succeeded: VolumeShrinkAttachmentRef[],
): Promise<boolean> {
  const { scope, patch, volume, sizeBytes } = ctx;
  const body: PatchVolumeRequest = { expectedRevision: volume.revision, sizeBytes };
  try {
    await api.patch(scopedPath(`/volumes/${volume.id}`, scope), body);
    await waitUntil(async () => {
      const latest = await api.get<VolumeDto>(scopedPath(`/volumes/${volume.id}`, scope));
      if (latest.sizeBytes === sizeBytes) return true;
      if (latest.needsAttention) {
        const failure = await lookupLatestIntentFailure(resourceIntentsPath(scope, IntentResourceType.Volume, volume.id));
        throw new Error(failure ?? latest.failureCode ?? '缩容失败');
      }
      return false;
    }, {
      label: '等待缩容',
      timeoutMs: 90_000,
      onTimeout: () => lookupLatestIntentFailure(resourceIntentsPath(scope, IntentResourceType.Volume, volume.id)),
    });
    return true;
  } catch (shrinkError) {
    if (shrinkError instanceof ApiError && shrinkError.code === FailureCode.VolumeShrinkRequiresDetach) {
      const leftover = parseVolumeShrinkAttachments(shrinkError);
      patch({
        attachments: leftover.length > 0 ? leftover : ctx.attachments,
        detached: [],
        error: '仍有挂载未清理，请重试一键卸载',
        failureStage: null,
        phase: 'list',
        busy: false,
      });
    } else {
      patch({
        detached: succeeded,
        error: errorMessage(shrinkError),
        failureStage: 'shrink',
        phase: 'failed',
        busy: false,
      });
    }
    return false;
  }
}

/** Mount the targets back one by one; returns whether all succeeded (state is set on failure). */
async function remountAll(ctx: ShrinkContext, queue: VolumeShrinkAttachmentRef[]): Promise<boolean> {
  const { scope, patch, volume } = ctx;
  const remounted: VolumeShrinkAttachmentRef[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const attachment = queue[index]!;
    try {
      const body: AttachVolumeRequest = {
        volumeId: volume.id,
        containerPath: attachment.containerPath,
        readOnly: attachment.readOnly ?? false,
      };
      await api.post<IntentAcceptedDto>(scopedPath(`/containers/${attachment.containerId}/volumes`, scope), body);
      await waitUntil(async () => {
        const listed = await loadAttachmentsForVolume(scope, volume.id);
        return listed.some((item) =>
          item.containerId === attachment.containerId
          && item.containerPath === attachment.containerPath
        );
      }, {
        label: '等待挂回',
        timeoutMs: 90_000,
        onTimeout: () => lookupLatestIntentFailure(resourceIntentsPath(scope, IntentResourceType.Container, attachment.containerId)),
      });
      remounted.push(attachment);
      patch({ progress: `已挂回 ${remounted.length}/${queue.length}` });
    } catch (attachError) {
      patch({
        pendingRemount: queue.slice(index),
        progress: `挂回成功 ${remounted.length} 个，第 ${index + 1} 个失败：${errorMessage(attachError)}`,
        error: errorMessage(attachError),
        failureStage: 'remount',
        phase: 'failed',
        busy: false,
      });
      return false;
    }
  }
  return true;
}
