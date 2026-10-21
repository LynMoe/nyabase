import type { VolumeShrinkAttachmentRef } from '../../../lib/storage-shrink.js';
import { Button } from '../../ui/button.js';
import { DialogFooter } from '../../ui/dialog.js';
import type { VolumeShrinkFlow } from './use-volume-shrink-flow.js';

const attachmentLabel = (attachment: VolumeShrinkAttachmentRef) =>
  attachment.containerName?.trim() || attachment.containerId;

/** The attachment list, progress, error and the explanation of the current stage. */
export function ShrinkDialogBody({ flow }: { flow: VolumeShrinkFlow }) {
  const { phase, failureStage, attachments, busy, progress, error, detached, shrinkSubmitted } = flow;
  return (
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
        <p className="text-sm">缩容已提交。是否将刚才卸载的挂载点挂回？</p>
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
            ? '缩容已提交，挂载已处理完毕。'
            : '已挂回；缩容未提交，容量未变。'}
        </p>
      )}
    </div>
  );
}

/** The buttons that fit the current stage. */
export function ShrinkDialogFooter({
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
