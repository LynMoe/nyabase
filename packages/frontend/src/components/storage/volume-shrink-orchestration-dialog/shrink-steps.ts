import {
  FailureCode,
  type AttachVolumeRequest,
  type IntentAcceptedDto,
  type PatchVolumeRequest,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../../lib/api.js';
import { ApiError, errorMessage } from '../../../lib/api-error.js';
import {
  formatDetachProgress,
  parseVolumeShrinkAttachments,
  type VolumeShrinkAttachmentRef,
  waitUntil,
} from '../../../lib/storage-shrink.js';
import { lookupLatestIntentFailure } from '../../../lib/intent-visibility.js';

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
