import { useState } from 'react';
import {
  ContainerStatus,
  type ContainerDto,
  type IntentAcceptedDto,
  type PatchContainerRootSizeRequest,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { waitUntil } from '../../lib/storage-shrink.js';
import { lookupLatestIntentFailure } from '../../lib/intent-visibility.js';
import { formatBytes } from '../../lib/utils.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';

type Phase = 'confirm' | 'stopping' | 'shrinking' | 'offer_start' | 'done' | 'failed';
type FailureStage = 'run' | 'offer_start' | null;

export function RootShrinkOrchestrationDialog({
  admin,
  container,
  sizeBytes,
  open,
  onOpenChange,
  onComplete,
}: {
  admin: boolean;
  container: ContainerDto;
  sizeBytes: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('confirm');
  const [failureStage, setFailureStage] = useState<FailureStage>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = admin ? `/admin/containers/${container.id}` : `/containers/${container.id}`;

  const run = async () => {
    setBusy(true);
    setError(null);
    setFailureStage(null);
    try {
      const current = await api.get<ContainerDto>(base);
      if (current.actual.status !== ContainerStatus.Stopped) {
        setPhase('stopping');
        setProgress('正在停止容器…');
        await api.post<IntentAcceptedDto>(`${base}/actions/stop`);
        await waitUntil(async () => {
          const latest = await api.get<ContainerDto>(base);
          return latest.actual.status === ContainerStatus.Stopped;
        }, {
          label: '等待容器停止',
          timeoutMs: 120_000,
          onTimeout: () => lookupLatestIntentFailure(`${base}/intents`),
        });
        setProgress('容器已停止');
      }

      setPhase('shrinking');
      setProgress('正在提交系统盘缩容…');
      const body: PatchContainerRootSizeRequest = { sizeBytes };
      await api.patch<IntentAcceptedDto>(`${base}/root-size`, body);
      await waitUntil(async () => {
        const latest = await api.get<ContainerDto>(base);
        if (latest.rootSizeBytes === sizeBytes || latest.rootSizePendingBytes === sizeBytes) return true;
        if (latest.needsAttention) {
          const failure = await lookupLatestIntentFailure(`${base}/intents`);
          throw new Error(failure ?? latest.failureReason ?? latest.failureCode ?? '系统盘缩容失败');
        }
        return false;
      }, {
        label: '等待系统盘缩容',
        timeoutMs: 120_000,
        onTimeout: () => lookupLatestIntentFailure(`${base}/intents`),
      });
      setProgress(null);
      setPhase('offer_start');
      onComplete();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : '请稍后重试');
      setFailureStage('run');
      setPhase('failed');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    setFailureStage(null);
    try {
      setProgress('正在启动容器…');
      await api.post<IntentAcceptedDto>(`${base}/actions/start`);
      setPhase('done');
      setProgress(null);
      onComplete();
      onOpenChange(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : '请稍后重试');
      setFailureStage('offer_start');
      setPhase('failed');
    } finally {
      setBusy(false);
    }
  };

  const showRunCta = phase === 'confirm' || (phase === 'failed' && failureStage === 'run');
  const showStartCta = phase === 'offer_start'
    || (phase === 'failed' && failureStage === 'offer_start');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="root-shrink-orchestration">
        <DialogHeader>
          <DialogTitle>缩容需要先停止容器</DialogTitle>
          <DialogDescription>
            此系统盘缩容前必须停止容器「{container.name}」；将依次停止 → 缩容 → 可选启动。目标容量 {formatBytes(sizeBytes)}。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {progress && <p className="text-sm text-muted-foreground" data-testid="root-shrink-progress">{progress}</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {phase === 'offer_start' && <p className="text-sm">已提交缩容，正在生效。是否启动容器？</p>}
          {phase === 'failed' && failureStage === 'offer_start' && (
            <p className="text-sm text-muted-foreground">启动失败。可仅重试启动，无需再次停止并缩容。</p>
          )}
          {phase === 'done' && <p className="text-sm text-muted-foreground">编排完成。</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>关闭</Button>
          {showRunCta && (
            <Button onClick={() => { void run(); }} disabled={busy}>
              {busy ? '执行中...' : phase === 'failed' ? '重试停止并缩容' : '停止并缩容'}
            </Button>
          )}
          {showStartCta && (
            <>
              {phase === 'offer_start' && (
                <Button variant="outline" onClick={() => { setPhase('done'); onOpenChange(false); }} disabled={busy}>
                  暂不启动
                </Button>
              )}
              <Button onClick={() => { void start(); }} disabled={busy}>
                {busy ? '启动中...' : phase === 'failed' ? '重试启动' : '启动容器'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
