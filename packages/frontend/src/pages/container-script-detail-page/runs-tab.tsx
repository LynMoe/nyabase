import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import {
  CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES,
  CONTAINER_SCRIPT_RUNS_KEPT,
  ContainerScriptRunStatus,
  type ContainerScriptDto,
  type ContainerScriptRunDto,
  type ContainerScriptRunListItemDto,
  type ContainerScriptRunPageDto,
} from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Pagination } from '../../components/ui/pagination.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { Field, FieldGrid, SelectField } from '../../components/layout/form-field.js';
import { QueryView } from '../../components/layout/query-view.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { RunStatusBadge } from '../../components/container-scripts/script-badges.js';
import { useCursorPages } from '../../hooks/use-cursor-pages.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { formatBytes } from '../../lib/utils.js';
import { runDuration, SCRIPT_IN_PROGRESS_POLL_MS, scriptTime, scriptTriggerLabel } from '../../lib/container-scripts.js';
import { useScriptTargets } from './targets-tab.js';

const PAGE_SIZES = [20, 50, 100] as const;
const ALL_CONTAINERS = 'all';

export function runsPath(scriptId: string, query: { containerId?: string; limit: number; before?: string }): string {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.containerId) params.set('containerId', query.containerId);
  if (query.before) params.set('before', query.before);
  return `/admin/container-scripts/${scriptId}/runs?${params.toString()}`;
}

function RunsTable({ runs, onOpen }: { runs: ContainerScriptRunListItemDto[]; onOpen: (runId: string) => void }) {
  return (
    <Table className="min-w-[960px]">
      <TableHeader>
        <TableRow>
          <TableHead>开始时间</TableHead>
          <TableHead>容器</TableHead>
          <TableHead>版本</TableHead>
          <TableHead>触发</TableHead>
          <TableHead>第几次</TableHead>
          <TableHead>状态</TableHead>
          <TableHead>退出码</TableHead>
          <TableHead>耗时</TableHead>
          <TableHead className="text-right">输出</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => (
          <TableRow key={run.id} className="cursor-pointer" onClick={() => onOpen(run.id)}>
            <TableCell className="whitespace-nowrap text-xs">{scriptTime(run.startedAt)}</TableCell>
            <TableCell className="max-w-[14rem]">
              <ResourceRef kind="container" id={run.containerId} name={run.containerName} scope="all" />
            </TableCell>
            <TableCell className="font-mono text-sm">v{run.version}</TableCell>
            <TableCell>{scriptTriggerLabel(run.trigger)}</TableCell>
            <TableCell className="tabular-nums">{run.attempt}</TableCell>
            <TableCell><RunStatusBadge status={run.status} /></TableCell>
            <TableCell className="font-mono text-sm">{run.exitCode ?? '—'}</TableCell>
            <TableCell className="whitespace-nowrap text-sm">{runDuration(run.startedAt, run.finishedAt)}</TableCell>
            <TableCell className="text-right">
              <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); onOpen(run.id); }}>查看</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** One run with its output (the end of stdout + stderr), refreshed until it finishes. */
function RunDetailDialog({
  scriptId,
  runId,
  onOpenChange,
}: {
  scriptId: string;
  runId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const runQuery = useQuery({
    queryKey: queryKeys.containerScripts.run(scriptId, runId ?? ''),
    queryFn: () => api.get<ContainerScriptRunDto>(`/admin/container-scripts/${scriptId}/runs/${runId}`),
    enabled: runId !== null,
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: query.state.data?.status === ContainerScriptRunStatus.Running ? 3_000 : false,
    }),
  });
  return (
    <Dialog open={runId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="container-script-run">
        <DialogHeader>
          <DialogTitle>执行记录</DialogTitle>
          <DialogDescription>输出为标准输出与标准错误合并后的最后 {formatBytes(CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES)}。</DialogDescription>
        </DialogHeader>
        <QueryView query={runQuery} resourceName="执行记录" loadingLabel="加载执行记录...">
          {(run) => (
            <div className="space-y-4">
              <FieldGrid min="9rem">
                <Field label="状态" value={<RunStatusBadge status={run.status} />} />
                <Field label="退出码" value={run.exitCode ?? '—'} mono />
                <Field label="容器" value={<ResourceRef kind="container" id={run.containerId} name={run.containerName} scope="all" />} />
                <Field label="服务器" value={<ResourceRef kind="server" id={run.serverId} />} />
                <Field label="版本" value={`v${run.version}`} mono />
                <Field label="触发" value={scriptTriggerLabel(run.trigger)} />
                <Field label="第几次尝试" value={run.attempt} />
                <Field label="开机标识" value={run.bootId ? <TechnicalId label="开机标识" value={run.bootId} kind="text" /> : null} />
                <Field label="开始" value={scriptTime(run.startedAt)} />
                <Field label="结束" value={run.finishedAt ? scriptTime(run.finishedAt) : '执行中'} />
                <Field label="耗时" value={runDuration(run.startedAt, run.finishedAt)} />
              </FieldGrid>
              {run.error ? <p className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{run.error}</p> : null}
              <pre
                className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-relaxed"
                data-testid="container-script-run-output"
              >
                {run.output || '（无输出）'}
              </pre>
            </div>
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

/** 执行记录: newest first, paged by `before`, optionally for one container. */
export function ScriptRunsTab({
  script,
  containerId,
  live,
  onContainerChange,
}: {
  script: ContainerScriptDto;
  containerId: string | undefined;
  live: boolean;
  onContainerChange: (containerId: string | undefined) => void;
}) {
  const [pageSize, setPageSize] = useState<number>(50);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const pages = useCursorPages(JSON.stringify([script.id, containerId ?? null, pageSize]));
  const runsQuery = useQuery({
    queryKey: queryKeys.containerScripts.runs(script.id, containerId ?? null, pageSize, pages.cursor ?? null),
    queryFn: () => api.get<ContainerScriptRunPageDto>(runsPath(script.id, { containerId, limit: pageSize, before: pages.cursor })),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: live && pages.page === 0 ? SCRIPT_IN_PROGRESS_POLL_MS : false,
    }),
  });
  const targetsQuery = useScriptTargets(script.id, null, false);
  const containerOptions: Array<[string, string]> = [
    [ALL_CONTAINERS, '全部容器'],
    ...(targetsQuery.data ?? []).map((target): [string, string] => [target.containerId, `${target.containerName} · ${target.serverName}`]),
  ];
  if (containerId && !containerOptions.some(([id]) => id === containerId)) containerOptions.push([containerId, containerId]);
  const turning = runsQuery.isPlaceholderData;

  return (
    <div className="space-y-3">
      <SectionCard
        flush
        testId="container-script-runs"
        description={`每个容器保留最近 ${CONTAINER_SCRIPT_RUNS_KEPT} 次执行`}
        toolbar={(
          <div className="max-w-sm">
            <SelectField
              id="container-script-runs-container"
              label="容器"
              value={containerId ?? ALL_CONTAINERS}
              options={containerOptions}
              onChange={(value) => onContainerChange(value === ALL_CONTAINERS ? undefined : value)}
            />
          </div>
        )}
      >
        <QueryView query={runsQuery} resourceName="执行记录" loadingLabel="加载执行记录...">
          {(data) => data.items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <History className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm font-medium">{pages.page > 0 ? '这一页已没有记录。' : '还没有执行记录。'}</p>
            </div>
          ) : (
            <div className={turning ? 'opacity-60 transition-opacity' : undefined} aria-busy={turning}>
              <RunsTable runs={data.items} onOpen={setOpenRun} />
            </div>
          )}
        </QueryView>
      </SectionCard>
      {runsQuery.data && (pages.page > 0 || runsQuery.data.nextBefore !== null) ? (
        <Pagination
          page={pages.page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          hasNext={runsQuery.data.nextBefore !== null}
          busy={turning}
          onPageChange={(next) => {
            if (next < pages.page) pages.previous();
            else pages.next(runsQuery.data?.nextBefore);
          }}
          onPageSizeChange={setPageSize}
        />
      ) : null}
      <RunDetailDialog scriptId={script.id} runId={openRun} onOpenChange={(open) => { if (!open) setOpenRun(null); }} />
    </div>
  );
}
