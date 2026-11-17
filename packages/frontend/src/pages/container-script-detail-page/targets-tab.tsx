import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import {
  ContainerScriptStatus,
  ContainerScriptTargetState,
  type ContainerScriptDto,
  type ContainerScriptTargetDto,
} from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { SegmentedFilter } from '../../components/layout/list-search.js';
import { QueryView } from '../../components/layout/query-view.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';
import { RunStatusBadge, TargetStateBadge } from '../../components/container-scripts/script-badges.js';
import { useScriptActions } from '../../components/container-scripts/use-script-actions.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import {
  countTotal,
  SCRIPT_IN_PROGRESS_POLL_MS,
  scriptTime,
  scriptTriggerLabel,
  TARGET_STATE_ORDER,
  targetStateBadge,
} from '../../lib/container-scripts.js';

type StateFilter = 'any' | ContainerScriptTargetState;

export function targetsPath(scriptId: string, state: ContainerScriptTargetState | null): string {
  const base = `/admin/container-scripts/${scriptId}/targets`;
  return state ? `${base}?state=${state}` : base;
}

/** The script's containers in one state (or all), refreshed while runs are due. */
export function useScriptTargets(scriptId: string, state: ContainerScriptTargetState | null, live: boolean) {
  return useQuery({
    queryKey: queryKeys.containerScripts.targets(scriptId, state),
    queryFn: () => api.get<ContainerScriptTargetDto[]>(targetsPath(scriptId, state)),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: live ? SCRIPT_IN_PROGRESS_POLL_MS : false }),
  });
}

function TargetRow({
  target,
  canRetry,
  retrying,
  onRetry,
  onShowRuns,
}: {
  target: ContainerScriptTargetDto;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
  onShowRuns: () => void;
}) {
  return (
    <TableRow className="align-top">
      <TableCell className="max-w-[14rem]">
        <ResourceRef kind="container" id={target.containerId} name={target.containerName} scope="all" />
      </TableCell>
      <TableCell className="max-w-[10rem]">
        <ResourceRef kind="user" id={target.owner.id} name={target.owner.displayName} username={target.owner.username} />
      </TableCell>
      <TableCell className="max-w-[10rem]">
        <ResourceRef kind="server" id={target.serverId} name={target.serverName} />
      </TableCell>
      <TableCell><TargetStateBadge state={target.state} /></TableCell>
      <TableCell className="font-mono text-sm">
        {target.version === null ? '—' : `v${target.version}`}
        {target.trigger ? <div className="font-sans text-xs text-muted-foreground">{scriptTriggerLabel(target.trigger)}</div> : null}
      </TableCell>
      <TableCell className="tabular-nums">{target.attempts}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{scriptTime(target.nextAttemptAt)}</TableCell>
      <TableCell>
        {target.lastRun ? (
          <span className="inline-flex flex-col gap-1">
            <RunStatusBadge status={target.lastRun.status} />
            <span className="text-xs text-muted-foreground">{scriptTime(target.lastRun.finishedAt ?? target.lastRun.startedAt)}</span>
          </span>
        ) : <span className="text-sm text-muted-foreground">—</span>}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="outline" onClick={onRetry} disabled={!canRetry || retrying}>
            <RotateCcw className="h-3.5 w-3.5" />重试
          </Button>
          <Button size="sm" variant="ghost" onClick={onShowRuns}>
            <History className="h-3.5 w-3.5" />查看记录
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 容器: where each container in scope stands with this script. */
export function ScriptTargetsTab({
  script,
  live,
  onShowRuns,
}: {
  script: ContainerScriptDto;
  live: boolean;
  onShowRuns: (containerId: string) => void;
}) {
  const [state, setState] = useState<StateFilter>('any');
  const targetsQuery = useScriptTargets(script.id, state === 'any' ? null : state, live);
  const { retry } = useScriptActions(script.id);
  const archived = script.status === ContainerScriptStatus.Archived;
  const options = [
    { value: 'any' as StateFilter, label: '全部', count: countTotal(script.counts) },
    ...TARGET_STATE_ORDER
      .filter((value) => (script.counts[value] ?? 0) > 0 || value === state)
      .map((value) => ({ value: value as StateFilter, label: targetStateBadge(value).label, count: script.counts[value] ?? 0 })),
  ];

  return (
    <SectionCard
      flush
      testId="container-script-targets"
      toolbar={<SegmentedFilter label="状态" value={state} options={options} onChange={setState} />}
    >
      <QueryView query={targetsQuery} resourceName="容器" loadingLabel="加载容器...">
        {(targets) => targets.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            {state === 'any' ? '范围内还没有容器。' : '没有处于此状态的容器。'}
          </p>
        ) : (
          <Table className="min-w-[1080px]">
            <TableHeader>
              <TableRow>
                <TableHead>容器</TableHead>
                <TableHead>所有者</TableHead>
                <TableHead>服务器</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>尝试</TableHead>
                <TableHead>下次重试</TableHead>
                <TableHead>最近执行</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {targets.map((target) => (
                <TargetRow
                  key={target.containerId}
                  target={target}
                  canRetry={!archived && target.state !== ContainerScriptTargetState.Running}
                  retrying={retry.isPending}
                  onRetry={() => retry.mutate([target.containerId])}
                  onShowRuns={() => onShowRuns(target.containerId)}
                />
              ))}
            </TableBody>
          </Table>
        )}
      </QueryView>
    </SectionCard>
  );
}
