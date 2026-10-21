import { useEffect, useState } from 'react';
import {
  type AttachVolumeRequest,
  FailureCode,
  type IntentAcceptedDto,
  type PatchVolumeRequest,
  type VolumeDto,
} from '@nyabase/common';
import { ApiError, errorMessage } from '../../lib/api-error.js';
import {
  formatDetachProgress,
  parseVolumeShrinkAttachments,
  type VolumeShrinkAttachmentRef,
  waitUntil,
} from '../../lib/storage-shrink.js';
import { api } from '../../lib/api.js';
import { lookupLatestIntentFailure } from '../../lib/intent-visibility.js';


/**
 * The shrink workflow for a volume that is still attached: unmount it from
 * every container, submit the shrink, then offer to mount it back. Failures
 * leave the dialog in a stage that says exactly what can be retried.
 */
export function useVolumeShrinkFlow({
  volume,
  sizeBytes,
  open,
  onComplete,
}: {
  volume: VolumeDto;
  sizeBytes: number;
  open: boolean;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<ShrinkPhase>('list');
  const [failureStage, setFailureStage] = useState<ShrinkFailureStage>(null);
  const [attachments, setAttachments] = useState<VolumeShrinkAttachmentRef[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detached, setDetached] = useState<VolumeShrinkAttachmentRef[]>([]);
  const [pendingRemount, setPendingRemount] = useState<VolumeShrinkAttachmentRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [shrinkSubmitted, setShrinkSubmitted] = useState(false);

  const ctx: ShrinkContext = {
    volume,
    sizeBytes,
    attachments,
    set: {
      phase: setPhase,
      failureStage: setFailureStage,
      attachments: setAttachments,
      progress: setProgress,
      error: setError,
      detached: setDetached,
      pendingRemount: setPendingRemount,
      busy: setBusy,
    },
  };

  /** Load the volume's attachments; on failure the dialog offers a reload. */
  const loadAttachments = async () => {
    try {
      setAttachments(await loadAttachmentsForVolume(volume.id));
      return true;
    } catch (loadError) {
      setError(errorMessage(loadError));
      setFailureStage('load');
      setPhase('failed');
      return false;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setPhase('list');
    setFailureStage(null);
    setProgress(null);
    setError(null);
    setDetached([]);
    setPendingRemount([]);
    setShrinkSubmitted(false);
    setBusy(true);
    void loadAttachments();
  }, [open, volume.id]);

  const reload = () => {
    setBusy(true);
    setError(null);
    void loadAttachments().then((loaded) => {
      if (loaded) {
        setFailureStage(null);
        setPhase('list');
      }
    });
  };

  const remainingAttachments = attachments.filter(
    (item) => !detached.some((done) => done.attachmentId === item.attachmentId),
  );

  const runDetachAndShrink = async (targets: VolumeShrinkAttachmentRef[]) => {
    setBusy(true);
    setError(null);
    setFailureStage(null);
    setPhase('detaching');
    const succeeded = [...detached];
    try {
      if (!await detachAll(ctx, targets, succeeded)) return;
      setDetached(succeeded);
      setPhase('shrinking');
      setProgress('正在提交缩容…');
      if (!await submitShrink(ctx, succeeded)) return;
      setPendingRemount(succeeded);
      setShrinkSubmitted(true);
      setPhase(succeeded.length > 0 ? 'remount' : 'done');
      setProgress(null);
      onComplete();
    } catch (runError) {
      setError(errorMessage(runError));
      setFailureStage('shrink');
      setPhase('failed');
    } finally {
      setBusy(false);
    }
  };

  const remount = async (targets: VolumeShrinkAttachmentRef[]) => {
    setBusy(true);
    setError(null);
    setProgress(null);
    // Keep failureStage until remount fully succeeds so abort remounts stay honest.
    const abortingWithoutShrink = !shrinkSubmitted;
    try {
      setPhase('remount');
      if (!await remountAll(ctx, [...targets])) return;
      setPendingRemount([]);
      setFailureStage(null);
      setPhase('done');
      if (!abortingWithoutShrink) onComplete();
    } finally {
      setBusy(false);
    }
  };

  return {
    phase,
    failureStage,
    attachments,
    progress,
    error,
    detached,
    pendingRemount,
    busy,
    shrinkSubmitted,
    remainingAttachments,
    setPhase,
    runDetachAndShrink,
    remount,
    reload,
  };
}

export type VolumeShrinkFlow = ReturnType<typeof useVolumeShrinkFlow>;

export type ShrinkPhase = 'list' | 'detaching' | 'shrinking' | 'remount' | 'done' | 'failed';
export type ShrinkFailureStage = 'load' | 'detach_partial' | 'shrink' | 'remount' | null;

export async function loadAttachmentsForVolume(
  volumeId: string,
): Promise<VolumeShrinkAttachmentRef[]> {
  const latest = await api.get<VolumeDto>(`/volumes/${volumeId}`);
  return latest.attachments.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    containerId: attachment.containerId,
    containerPath: attachment.containerPath,
    containerName: attachment.containerName,
  }));
}

/** What the workflow steps read, and the state they report into. */
export interface ShrinkContext {
  readonly volume: VolumeDto;
  readonly sizeBytes: number;
  readonly attachments: VolumeShrinkAttachmentRef[];
  readonly set: {
    phase: (value: ShrinkPhase) => void;
    failureStage: (value: ShrinkFailureStage) => void;
    attachments: (value: VolumeShrinkAttachmentRef[]) => void;
    progress: (value: string | null) => void;
    error: (value: string | null) => void;
    detached: (value: VolumeShrinkAttachmentRef[]) => void;
    pendingRemount: (value: VolumeShrinkAttachmentRef[]) => void;
    busy: (value: boolean) => void;
  };
}

/** Detach the targets one by one; false when one failed (the failure state is already set). */
export async function detachAll(
  ctx: ShrinkContext,
  targets: VolumeShrinkAttachmentRef[],
  succeeded: VolumeShrinkAttachmentRef[],
): Promise<boolean> {
  const { set, attachments, volume } = ctx;
  for (let index = 0; index < targets.length; index += 1) {
    const attachment = targets[index]!;
    set.progress(formatDetachProgress(succeeded.length, attachments.length, null, null));
    try {
      await api.delete<IntentAcceptedDto>(
        `/containers/${attachment.containerId}/volumes/${attachment.attachmentId}`,
      );
      await waitUntil(async () => {
        const remaining = await loadAttachmentsForVolume(volume.id);
        return !remaining.some((item) => item.attachmentId === attachment.attachmentId);
      }, {
        label: '等待卸载',
        timeoutMs: 90_000,
        onTimeout: () => lookupLatestIntentFailure(`/containers/${attachment.containerId}/intents`),
      });
      succeeded.push(attachment);
      set.detached([...succeeded]);
      set.progress(formatDetachProgress(succeeded.length, attachments.length, null, null));
    } catch (detachError) {
      const message = errorMessage(detachError);
      set.progress(formatDetachProgress(succeeded.length, attachments.length, index, message));
      set.error(message);
      set.detached(succeeded);
      set.failureStage('detach_partial');
      set.phase('failed');
      set.busy(false);
      return false;
    }
  }
  return true;
}

/** Submit the shrink and wait for it; false when it did not complete (state already set). */
export async function submitShrink(
  ctx: ShrinkContext,
  succeeded: VolumeShrinkAttachmentRef[],
): Promise<boolean> {
  const { set, volume, sizeBytes } = ctx;
  const body: PatchVolumeRequest = {
    expectedRevision: volume.revision,
    sizeBytes,
  };
  try {
    await api.patch(`/volumes/${volume.id}`, body);
    await waitUntil(async () => {
      const latest = await api.get<VolumeDto>(`/volumes/${volume.id}`);
      if (latest.sizeBytes === sizeBytes) return true;
      if (latest.needsAttention) {
        const failure = await lookupLatestIntentFailure(`/volumes/${volume.id}/intents`);
        throw new Error(failure ?? latest.failureCode ?? '缩容失败');
      }
      return false;
    }, {
      label: '等待缩容',
      timeoutMs: 90_000,
      onTimeout: () => lookupLatestIntentFailure(`/volumes/${volume.id}/intents`),
    });
    return true;
  } catch (shrinkError) {
    if (
      shrinkError instanceof ApiError
      && shrinkError.code === FailureCode.VolumeShrinkRequiresDetach
    ) {
      const leftover = parseVolumeShrinkAttachments(shrinkError);
      set.attachments(leftover.length > 0 ? leftover : ctx.attachments);
      set.detached([]);
      set.error('仍有挂载未清理，请重试一键卸载');
      set.failureStage(null);
      set.phase('list');
    } else {
      set.detached(succeeded);
      set.error(errorMessage(shrinkError));
      set.failureStage('shrink');
      set.phase('failed');
    }
    set.busy(false);
    return false;
  }
}

/** Mount the targets back one by one; returns whether all succeeded (state is set on failure). */
export async function remountAll(
  ctx: ShrinkContext,
  queue: VolumeShrinkAttachmentRef[],
): Promise<boolean> {
  const { set, volume } = ctx;
  const remounted: VolumeShrinkAttachmentRef[] = [];
  for (let index = 0; index < queue.length; index += 1) {
    const attachment = queue[index]!;
    try {
      const body: AttachVolumeRequest = {
        volumeId: volume.id,
        containerPath: attachment.containerPath,
        readOnly: attachment.readOnly ?? false,
      };
      await api.post<IntentAcceptedDto>(
        `/containers/${attachment.containerId}/volumes`,
        body,
      );
      await waitUntil(async () => {
        const listed = await loadAttachmentsForVolume(volume.id);
        return listed.some((item) =>
          item.containerId === attachment.containerId
          && item.containerPath === attachment.containerPath
        );
      }, {
        label: '等待挂回',
        timeoutMs: 90_000,
        onTimeout: () => lookupLatestIntentFailure(`/containers/${attachment.containerId}/intents`),
      });
      remounted.push(attachment);
      set.progress(`已挂回 ${remounted.length}/${queue.length}`);
    } catch (attachError) {
      set.pendingRemount(queue.slice(index));
      set.progress(
        `挂回成功 ${remounted.length} 个，第 ${index + 1} 个失败：${errorMessage(attachError)}`,
      );
      set.error(errorMessage(attachError));
      set.failureStage('remount');
      set.phase('failed');
      set.busy(false);
      return false;
    }
  }
  return true;
}
