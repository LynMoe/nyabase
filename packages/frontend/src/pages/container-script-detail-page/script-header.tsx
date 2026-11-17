import { useState } from 'react';
import { Archive, Pause, Pencil, Play, RotateCcw, Upload } from 'lucide-react';
import { ContainerScriptStatus, type ContainerScriptDto } from '@nyabase/common';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { Field, FieldGrid } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { CountsSummary } from '../../components/container-scripts/script-badges.js';
import { EditScriptDialog } from '../../components/container-scripts/edit-script-dialog.js';
import { ScriptFormDialog } from '../../components/container-scripts/script-form-dialog.js';
import { useScriptActions } from '../../components/container-scripts/use-script-actions.js';
import { countTotal, pauseBannerText, scopeSummary, scriptTime } from '../../lib/container-scripts.js';

type Confirming = 'archive' | 'retry' | null;

/** 发布新版本, 编辑, 暂停 / 恢复, 重试全部失败, 归档; an archived script has none. */
export function ScriptActions({ script }: { script: ContainerScriptDto }) {
  const { command, retry } = useScriptActions(script.id);
  const [publishing, setPublishing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  if (script.status === ContainerScriptStatus.Archived) return null;
  const paused = script.status === ContainerScriptStatus.Paused;
  const failed = script.counts.failed ?? 0;
  const run = (action: 'pause' | 'resume' | 'archive', then?: () => void) =>
    command.mutate({ action, expectedRevision: script.revision }, { onSuccess: then });

  return (
    <>
      <Button onClick={() => setPublishing(true)} data-testid="container-script-publish">
        <Upload className="h-4 w-4" />发布新版本
      </Button>
      <Button variant="outline" onClick={() => setEditing(true)}>
        <Pencil className="h-4 w-4" />编辑
      </Button>
      {paused ? (
        <Button variant="outline" onClick={() => run('resume')} disabled={command.isPending}>
          <Play className="h-4 w-4" />恢复
        </Button>
      ) : (
        <Button variant="outline" onClick={() => run('pause')} disabled={command.isPending}>
          <Pause className="h-4 w-4" />暂停
        </Button>
      )}
      <Button variant="outline" onClick={() => setConfirming('retry')} disabled={failed === 0 || retry.isPending}>
        <RotateCcw className="h-4 w-4" />重试全部失败{failed > 0 ? `（${failed}）` : ''}
      </Button>
      <Button variant="ghost-destructive" onClick={() => setConfirming('archive')}>
        <Archive className="h-4 w-4" />归档
      </Button>
      <ScriptFormDialog open={publishing} onOpenChange={setPublishing} target={{ kind: 'publish', script }} />
      <EditScriptDialog script={script} open={editing} onOpenChange={setEditing} />
      <ConfirmDialog
        open={confirming === 'archive'}
        title="归档容器脚本？"
        description={`「${script.name}」归档后不再在任何容器上执行，也不能再发布新版本；执行记录保留。`}
        confirmLabel="确认归档"
        pendingLabel="归档中..."
        pending={command.isPending}
        testId="container-script-archive-confirm"
        onConfirm={() => run('archive', () => setConfirming(null))}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
      />
      <ConfirmDialog
        open={confirming === 'retry'}
        title="重试全部失败的容器？"
        description={`将在 ${failed} 个失败的容器上按当前版本重新执行。`}
        confirmLabel="确认重试"
        confirmVariant="default"
        pendingLabel="提交中..."
        pending={retry.isPending}
        onConfirm={() => retry.mutate(undefined, { onSuccess: () => setConfirming(null) })}
        onOpenChange={(open) => { if (!open) setConfirming(null); }}
      />
    </>
  );
}

/** Why the script is paused and what to do about it. */
export function PausedBanner({ script }: { script: ContainerScriptDto }) {
  const text = pauseBannerText(script);
  if (!text) return null;
  return (
    <Alert variant="warning" data-testid="container-script-paused">
      <Pause className="h-4 w-4" />
      <AlertTitle>已暂停</AlertTitle>
      <AlertDescription>{text}暂停期间不会开始新的执行。</AlertDescription>
    </Alert>
  );
}

/** The current version at a glance: how far it got, what it covers, who made the script. */
export function ScriptSummaryCard({ script }: { script: ContainerScriptDto }) {
  return (
    <SectionCard>
      <FieldGrid min="10rem">
        <Field label="优先级" value={script.priority} mono />
        <Field label="当前版本" value={`v${script.current.version}`} mono />
        <Field label="范围" value={scopeSummary(script.current.scope)} />
        <Field label={`进度（共 ${countTotal(script.counts)} 个容器）`} value={<CountsSummary counts={script.counts} />} className="sm:col-span-2" />
        <Field
          label="创建者"
          value={script.createdBy
            ? <ResourceRef kind="user" id={script.createdBy.id} name={script.createdBy.displayName} username={script.createdBy.username} />
            : '已删除的用户'}
        />
        <Field label="创建时间" value={scriptTime(script.createdAt)} />
        <Field label="更新时间" value={scriptTime(script.updatedAt)} />
      </FieldGrid>
    </SectionCard>
  );
}
