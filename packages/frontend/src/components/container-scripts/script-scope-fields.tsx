import { useState } from 'react';
import { ChevronDown, ChevronRight, Eye } from 'lucide-react';
import type { ContainerScriptPreviewDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { SegmentedFilter } from '../layout/list-search.js';
import { personLabel } from '../../lib/container-scripts.js';
import type { ScriptForm } from '../../lib/container-script-form.js';
import { IdPicker } from './id-picker.js';
import type { ScopeOptions } from './use-scope-options.js';

const SCOPE_MODES = [
  { value: 'all', label: '全部容器' },
  { value: 'filter', label: '筛选' },
] as const;

/** 范围: all containers or the filters (every non-empty one must match), the exclusions, and a preview. */
export function ScriptScopeFields({
  form,
  update,
  options,
  error,
  preview,
  previewPending,
  onPreview,
}: {
  form: ScriptForm;
  update: (changes: Partial<ScriptForm>) => void;
  options: ScopeOptions;
  error?: string;
  preview: ContainerScriptPreviewDto | null;
  previewPending: boolean;
  onPreview: () => void;
}) {
  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="container-script-scope">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">范围</p>
        <SegmentedFilter
          label="范围"
          value={form.scopeAll ? 'all' : 'filter'}
          options={SCOPE_MODES}
          onChange={(mode) => update({ scopeAll: mode === 'all' })}
        />
      </div>
      {form.scopeAll ? (
        <p className="text-xs text-muted-foreground">所有现有与将来创建的容器（排除的除外）。</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            每个已选的条件都要满足（例如同时选了服务器和镜像：这些服务器上用这些镜像的容器）。
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <IdPicker
              id="container-script-scope-servers"
              label="服务器"
              options={options.servers}
              loading={options.loading.servers}
              value={form.serverIds}
              onChange={(serverIds) => update({ serverIds })}
            />
            <IdPicker
              id="container-script-scope-images"
              label="镜像"
              options={options.images}
              loading={options.loading.images}
              value={form.imageIds}
              onChange={(imageIds) => update({ imageIds })}
            />
            <IdPicker
              id="container-script-scope-owners"
              label="用户（容器所有者）"
              options={options.users}
              loading={options.loading.users}
              value={form.ownerIds}
              onChange={(ownerIds) => update({ ownerIds })}
            />
            <IdPicker
              id="container-script-scope-containers"
              label="指定容器"
              options={options.containers}
              loading={options.loading.containers}
              value={form.containerIds}
              onChange={(containerIds) => update({ containerIds })}
            />
          </div>
        </>
      )}
      <IdPicker
        id="container-script-scope-exclude"
        label="排除容器"
        options={options.containers}
        loading={options.loading.containers}
        value={form.excludeContainerIds}
        onChange={(excludeContainerIds) => update({ excludeContainerIds })}
        placeholder="搜索要排除的容器"
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="space-y-2">
        <Button type="button" size="sm" variant="outline" onClick={onPreview} disabled={previewPending}>
          <Eye className="h-4 w-4" />{previewPending ? '预览中...' : '预览范围'}
        </Button>
        {preview ? <ScopePreviewSummary preview={preview} /> : null}
      </div>
    </section>
  );
}

/** How many containers the scope covers now: in total, running, per server, and (collapsed) which. */
export function ScopePreviewSummary({ preview }: { preview: ContainerScriptPreviewDto }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm" data-testid="container-script-preview">
      <p>
        当前范围内 <span className="font-semibold tabular-nums">{preview.total}</span> 个容器，
        其中运行中 <span className="font-semibold tabular-nums">{preview.running}</span> 个
      </p>
      {preview.servers.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {preview.servers.map((server) => (
            <li key={server.serverId}>
              {server.serverName}：<span className="tabular-nums">{server.total}</span>
              （运行 <span className="tabular-nums">{server.running}</span>）
            </li>
          ))}
        </ul>
      ) : null}
      {preview.containers.length > 0 ? (
        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-primary"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {expanded ? '收起容器列表' : '查看容器列表'}
          </button>
          {expanded ? (
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto text-xs">
              {preview.containers.map((container) => (
                <li key={container.id} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{container.name}</span>
                  <span className="text-muted-foreground">{container.serverName}</span>
                  <span className="text-muted-foreground">{personLabel(container.owner)}</span>
                  {container.running ? null : <span className="text-muted-foreground">未运行</span>}
                </li>
              ))}
              {preview.truncated ? (
                <li className="text-muted-foreground">只列出前 {preview.containers.length} 个</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
