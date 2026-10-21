import { useEffect, useState } from 'react';
import type { VolumeDto } from '@nyabase/common';
import { errorMessage } from '../../../lib/api-error.js';
import type { VolumeShrinkAttachmentRef } from '../../../lib/storage-shrink.js';
import {
  detachAll,
  loadAttachmentsForVolume,
  remountAll,
  submitShrink,
  type ShrinkContext,
  type ShrinkFailureStage,
  type ShrinkPhase,
} from './shrink-steps.js';

export type { ShrinkFailureStage, ShrinkPhase };

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
