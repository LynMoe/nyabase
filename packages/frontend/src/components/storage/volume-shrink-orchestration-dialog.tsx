import { useEffect, useState } from 'react';
import {
  FailureCode,
  type AttachVolumeRequest,
  type IntentAcceptedDto,
  type PatchVolumeRequest,
  type VolumeDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { ApiError } from '../../lib/api-error.js';
import {
  formatDetachProgress,
  parseVolumeShrinkAttachments,
  type VolumeShrinkAttachmentRef,
  waitUntil,
} from '../../lib/storage-shrink.js';
import { lookupLatestIntentFailure } from '../../lib/intent-visibility.js';
import { formatBytes } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';

type Phase = 'list' | 'detaching' | 'shrinking' | 'remount' | 'done' | 'failed';
type FailureStage = 'load' | 'detach_partial' | 'shrink' | 'remount' | null;

export function VolumeShrinkOrchestrationDialog({
  volume,
  sizeBytes,
  open,
  onOpenChange,
  onComplete,
}: {
  volume: VolumeDto;
  sizeBytes: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('list');
  const [failureStage, setFailureStage] = useState<FailureStage>(null);
  const [attachments, setAttachments] = useState<VolumeShrinkAttachmentRef[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detached, setDetached] = useState<VolumeShrinkAttachmentRef[]>([]);
  const [pendingRemount, setPendingRemount] = useState<VolumeShrinkAttachmentRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [shrinkSubmitted, setShrinkSubmitted] = useState(false);

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
    void (async () => {
      try {
        const listed = await loadAttachmentsForVolume(volume.id);
        setAttachments(listed);
      } catch (loadError) {
        setError(errorMessage(loadError));
        setFailureStage('load');
        setPhase('failed');
      } finally {
        setBusy(false);
      }
    })();
  }, [open, volume.id]);

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
      for (let index = 0; index < targets.length; index += 1) {
        const attachment = targets[index]!;
        setProgress(formatDetachProgress(succeeded.length, attachments.length, null, null));
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
          setDetached([...succeeded]);
          setProgress(formatDetachProgress(succeeded.length, attachments.length, null, null));
        } catch (detachError) {
          const message = errorMessage(detachError);
          setProgress(formatDetachProgress(succeeded.length, attachments.length, index, message));
          setError(message);
          setDetached(succeeded);
          setFailureStage('detach_partial');
          setPhase('failed');
          setBusy(false);
          return;
        }
      }
      setDetached(succeeded);
      setPhase('shrinking');
      setProgress('正在提交缩容…');
      const body: PatchVolumeRequest = {
        expectedRevision: volume.generation,
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
      } catch (shrinkError) {
        if (
          shrinkError instanceof ApiError
          && shrinkError.code === FailureCode.VolumeShrinkRequiresDetach
        ) {
          const leftover = parseVolumeShrinkAttachments(shrinkError);
          setAttachments(leftover.length > 0 ? leftover : attachments);
          setDetached([]);
          setError('仍有挂载未清理，请重试一键卸载');
          setFailureStage(null);
          setPhase('list');
          setBusy(false);
          return;
        }
        setDetached(succeeded);
        setError(errorMessage(shrinkError));
        setFailureStage('shrink');
        setPhase('failed');
        setBusy(false);
        return;
      }
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
    const remounted: VolumeShrinkAttachmentRef[] = [];
    const queue = [...targets];
    const abortingWithoutShrink = !shrinkSubmitted;
    try {
      setPhase('remount');
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
          setProgress(`已挂回 ${remounted.length}/${queue.length}`);
        } catch (attachError) {
          const remaining = queue.slice(index);
          setPendingRemount(remaining);
          setProgress(
            `挂回成功 ${remounted.length} 个，第 ${index + 1} 个失败：${errorMessage(attachError)}`,
          );
          setError(errorMessage(attachError));
          setFailureStage('remount');
          setPhase('failed');
          setBusy(false);
          return;
        }
      }
      setPendingRemount([]);
      setFailureStage(null);
      setPhase('done');
      if (!abortingWithoutShrink) onComplete();
    } finally {
      setBusy(false);
    }
  };

  const attachmentLabel = (attachment: VolumeShrinkAttachmentRef) =>
    attachment.containerName?.trim() || attachment.containerId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="volume-shrink-orchestration">
        <DialogHeader>
          <DialogTitle>缩容需要先卸载</DialogTitle>
          <DialogDescription>
            缩容前必须从相关容器卸载此数据卷（共 {attachments.length} 处挂载），卸载完成后再提交缩容。目标容量 {formatBytes(sizeBytes)}。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {attachments.length === 0 && phase === 'list' && !busy ? (
            <p className="text-sm text-muted-foreground">当前未发现挂载，可直接提交缩容。</p>
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
            <p className="text-sm">缩容意图已提交。是否将刚才卸载的挂载点挂回？</p>
          )}
          {phase === 'failed' && failureStage === 'detach_partial' && (
            <p className="text-sm text-muted-foreground">
              部分挂载已卸载。可先挂回已成功项，或继续重试剩余卸载后再缩容。
            </p>
          )}
          {phase === 'failed' && failureStage === 'remount' && (
            <p className="text-sm text-muted-foreground">
              挂回未完成。请仅重试挂回，不要再次执行卸载与缩容。
            </p>
          )}
          {phase === 'failed' && failureStage === 'shrink' && detached.length > 0 && (
            <p className="text-sm text-muted-foreground">
              缩容提交失败，相关挂载仍处于已卸载状态，可先挂回后再处理。
            </p>
          )}
          {phase === 'done' && (
            <p className="text-sm text-muted-foreground">
              {shrinkSubmitted
                ? '缩容已提交，挂载已处理完毕。列表容量稍后更新。'
                : '已挂回；缩容未提交，容量未变。'}
            </p>
          )}
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button>
          {phase === 'list' && (
            <Button
              onClick={() => { void runDetachAndShrink(attachments); }}
              disabled={busy}
            >
              {busy ? '执行中...' : attachments.length === 0 ? '提交缩容' : '一键卸载并缩容'}
            </Button>
          )}
          {phase === 'failed' && failureStage === 'load' && (
            <Button
              onClick={() => {
                setBusy(true);
                setError(null);
                void (async () => {
                  try {
                    const listed = await loadAttachmentsForVolume(volume.id);
                    setAttachments(listed);
                    setFailureStage(null);
                    setPhase('list');
                  } catch (loadError) {
                    setError(errorMessage(loadError));
                    setFailureStage('load');
                    setPhase('failed');
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              disabled={busy}
            >
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
              <Button
                onClick={() => { void runDetachAndShrink([]); }}
                disabled={busy}
              >
                {busy ? '执行中...' : '重试缩容'}
              </Button>
            </>
          )}
          {phase === 'failed' && failureStage === 'remount' && (
            <Button
              onClick={() => { void remount(pendingRemount.length > 0 ? pendingRemount : detached); }}
              disabled={busy}
            >
              {busy ? '挂回中...' : '重试挂回'}
            </Button>
          )}
          {phase === 'remount' && (
            <>
              <Button variant="outline" onClick={() => { setPhase('done'); onOpenChange(false); }} disabled={busy}>
                暂不挂回
              </Button>
              <Button
                onClick={() => { void remount(pendingRemount.length > 0 ? pendingRemount : detached); }}
                disabled={busy}
              >
                {busy ? '挂回中...' : '挂回全部'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function loadAttachmentsForVolume(
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
