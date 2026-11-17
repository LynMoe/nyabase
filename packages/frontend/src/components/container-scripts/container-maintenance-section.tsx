import { useQuery } from '@tanstack/react-query';
import {
  ContainerScriptTargetState,
  type ContainerMaintenanceItemDto,
  type ListScope,
} from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { SectionCard } from '../layout/section-card.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { scriptTime } from '../../lib/container-scripts.js';
import { RunStatusBadge, TargetStateBadge } from './script-badges.js';

/** While a maintenance script is due or running in the container, refresh this often. */
const MAINTENANCE_ACTIVE_POLL_MS = 10_000;

export function maintenanceInProgress(items: readonly ContainerMaintenanceItemDto[] | undefined): boolean {
  return (items ?? []).some((item) => item.state === ContainerScriptTargetState.Running
    || item.state === ContainerScriptTargetState.Pending);
}

/**
 * 维护记录: the platform's maintenance scripts that ran or will run in this
 * container — names, state and when, never the script or its output. Hidden
 * when there are none (or the list cannot be read).
 */
export function ContainerMaintenanceSection({ containerId, scope }: { containerId: string; scope: ListScope }) {
  const query = useQuery({
    queryKey: queryKeys.containers.maintenance(scope, containerId),
    queryFn: () => api.get<ContainerMaintenanceItemDto[]>(scopedPath(`/containers/${containerId}/maintenance`, scope)),
    refetchInterval: (q) => queryPollInterval(q.state, {
      activeIntervalMs: maintenanceInProgress(q.state.data) ? MAINTENANCE_ACTIVE_POLL_MS : false,
    }),
  });
  const items = query.data ?? [];
  if (items.length === 0) return null;
  return (
    <SectionCard
      title="维护记录"
      description="平台在此容器内执行的维护脚本"
      flush
      testId="container-maintenance"
    >
      <Table className="min-w-[560px]">
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>最近执行</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.scriptId}>
              <TableCell className="max-w-[18rem]">
                <span className="inline-flex max-w-full items-center gap-2">
                  <span className="min-w-0 truncate"><ResourceRef kind="container-script" id={item.scriptId} name={item.name} /></span>
                  {item.everyBoot ? <Badge variant="info">每次开机</Badge> : null}
                </span>
              </TableCell>
              <TableCell><TargetStateBadge state={item.state} /></TableCell>
              <TableCell>
                {item.lastRun ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <RunStatusBadge status={item.lastRun.status} />
                    <span className="text-xs text-muted-foreground">{scriptTime(item.lastRun.finishedAt ?? item.lastRun.startedAt)}</span>
                  </span>
                ) : <span className="text-sm text-muted-foreground">尚未执行</span>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
