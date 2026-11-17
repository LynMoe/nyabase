import { useState } from 'react';
import { Download } from 'lucide-react';
import type { ContainerScriptDto, ContainerScriptFileDto, ContainerScriptScope, ContainerScriptVersionDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { Field, FieldGrid } from '../layout/form-field.js';
import { SectionCard } from '../layout/section-card.js';
import { ResourceRef, type ResourceKind } from '../refs/resource-ref.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { formatBytes } from '../../lib/utils.js';
import {
  fileOwnerLabel,
  limitLabel,
  personLabel,
  scriptTime,
  stoppedPolicyLabel,
  timeoutLabel,
} from '../../lib/container-scripts.js';
import { TriggerBadges } from './script-badges.js';

/** Save an uploaded file's content (fetched with the session's credentials) under its name. */
export async function downloadScriptFile(file: Pick<ContainerScriptFileDto, 'sha256' | 'name'>): Promise<void> {
  const blob = await api.getBlob(`/admin/container-scripts/blobs/${file.sha256}`);
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function DownloadButton({ file }: { file: ContainerScriptFileDto }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      aria-label={`下载 ${file.name}`}
      onClick={() => {
        setBusy(true);
        downloadScriptFile(file)
          .catch((error: unknown) => toast({ title: '下载失败', description: errorMessage(error), variant: 'destructive' }))
          .finally(() => setBusy(false));
      }}
    >
      <Download className="h-4 w-4" />下载
    </Button>
  );
}

function ScriptFilesTable({ files }: { files: ContainerScriptFileDto[] }) {
  if (files.length === 0) return <p className="px-6 py-4 text-sm text-muted-foreground">没有文件</p>;
  return (
    <Table className="min-w-[640px]">
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          <TableHead>大小</TableHead>
          <TableHead>安装路径</TableHead>
          <TableHead>权限</TableHead>
          <TableHead>属主</TableHead>
          <TableHead className="text-right">内容</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {files.map((file) => (
          <TableRow key={file.name}>
            <TableCell className="font-mono text-sm">{file.name}</TableCell>
            <TableCell className="tabular-nums">{formatBytes(file.sizeBytes)}</TableCell>
            <TableCell className="font-mono text-sm">
              {file.destination?.path ?? <span className="font-sans text-muted-foreground">不安装</span>}
            </TableCell>
            <TableCell className="font-mono text-sm">{file.destination?.mode ?? '—'}</TableCell>
            <TableCell>{file.destination ? fileOwnerLabel(file.destination.owner) : '—'}</TableCell>
            <TableCell className="text-right"><DownloadButton file={file} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RefList({ kind, ids }: { kind: ResourceKind; ids: string[] }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
      {ids.map((id, index) => (
        <span key={id}>
          <ResourceRef kind={kind} id={id} scope="all" />{index < ids.length - 1 ? '，' : ''}
        </span>
      ))}
    </span>
  );
}

/** The scope's lists by name (each one links to its page). */
export function ScopeDetails({ scope }: { scope: ContainerScriptScope }) {
  const rows: Array<[string, ResourceKind, string[]]> = [
    ['服务器', 'server', scope.serverIds],
    ['镜像', 'image', scope.imageIds],
    ['用户', 'user', scope.ownerIds],
    ['容器', 'container', scope.containerIds],
  ];
  return (
    <div className="space-y-2 text-sm">
      {scope.all ? <p>全部容器</p> : (
        <>
          {rows.filter(([, , ids]) => ids.length > 0).map(([label, kind, ids]) => (
            <div key={label} className="grid gap-1 sm:grid-cols-[5rem_minmax(0,1fr)]">
              <span className="text-muted-foreground">{label}</span>
              <RefList kind={kind} ids={ids} />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">同时满足以上每个条件的容器</p>
        </>
      )}
      {scope.excludeContainerIds.length > 0 ? (
        <div className="grid gap-1 sm:grid-cols-[5rem_minmax(0,1fr)]">
          <span className="text-muted-foreground">排除</span>
          <RefList kind="container" ids={scope.excludeContainerIds} />
        </div>
      ) : null}
    </div>
  );
}

/** One version, read-only: triggers and settings, scope, files (downloadable) and the script. */
export function ScriptVersionView({
  script,
  version,
}: {
  script: Pick<ContainerScriptDto, 'everyBoot'>;
  version: ContainerScriptVersionDto;
}) {
  return (
    <div className="space-y-4" data-testid="container-script-version">
      <SectionCard title={`v${version.version}`} description={version.note || undefined}>
        <FieldGrid min="10rem">
          <Field label="触发" value={<TriggerBadges script={script} version={version} />} />
          {version.applyNow && !script.everyBoot ? (
            <Field label="停机容器" value={stoppedPolicyLabel(version.stoppedPolicy)} />
          ) : null}
          <Field label="超时" value={timeoutLabel(version.timeoutSeconds)} />
          <Field label="最多尝试次数" value={version.maxAttempts} />
          <Field label="同时执行数（全平台）" value={limitLabel(version.maxParallel, '不额外限制')} />
          <Field label="同时执行数（每台服务器）" value={limitLabel(version.maxParallelPerServer, '不额外限制')} />
          <Field label="灰度台数" value={limitLabel(version.canaryCount, '不灰度')} />
          <Field label="失败自动暂停阈值" value={limitLabel(version.pauseAfterFailures, '不自动暂停')} />
          <Field label="发布者" value={personLabel(version.publishedBy)} />
          <Field label="发布时间" value={scriptTime(version.publishedAt)} />
        </FieldGrid>
      </SectionCard>
      <SectionCard title="范围">
        <ScopeDetails scope={version.scope} />
      </SectionCard>
      <SectionCard title="文件" flush>
        <ScriptFilesTable files={version.files} />
      </SectionCard>
      <SectionCard title="脚本">
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
          {version.script}
        </pre>
      </SectionCard>
    </div>
  );
}
