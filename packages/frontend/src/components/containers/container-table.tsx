import { Link } from '@tanstack/react-router';
import { ChevronsDownUp, ChevronsUpDown, TriangleAlert } from 'lucide-react';
import type { ContainerDto } from '@nyabase/common';
import { useState } from 'react';
import { ContainerActionBar, type ContainerBarAction } from './container-action-bar.js';
import { ConsoleShortcut } from './console-shortcut.js';
import { ContainerRemaining } from './container-expiry.js';
import { ContainerGroupHeaderItem, ContainerGroupHeaderRow } from './container-group-header.js';
import { StatusBadge } from '../layout/status-badge.js';
import { UsageMeter } from '../performance/usage-meter.js';
import { Button } from '../ui/button.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { useResourceMutationPending } from '../../lib/resource-mutation-gate.js';
import { containerLifecyclePending, containerStatusPending } from '../../lib/in-progress.js';
import {
  compactReading,
  cpuReading,
  gpuCardCount,
  gpuReading,
  liveSample,
  memoryReading,
  rootDiskReading,
} from '../../lib/container-usage.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { cn } from '../../lib/utils.js';
import { useIsNarrow } from '../../hooks/use-dom-state.js';
import { useContainerLiveUsage, type ContainerLiveUsageIndex } from '../../hooks/use-container-live-usage.js';
import { SectionCard } from '../layout/section-card.js';
import { ListSearch, SegmentedFilter } from '../layout/list-search.js';
import {
  type ContainerStatusFilter,
  containerStatusOptions,
  filterContainers,
} from '../../lib/container-filter.js';
import {
  CONTAINER_GROUPING_OPTIONS,
  type ContainerGroup,
  type ContainerGrouping,
  groupContainers,
  mergedColumn,
  repeatsPrevious,
} from '../../lib/container-groups.js';

type ContainerColumns = { owner: boolean; server: boolean; gpu: boolean };

type ActionHandler = (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;

type RowProps = {
  container: ContainerDto;
  admin: boolean;
  usage: ContainerLiveUsageIndex;
  columns: ContainerColumns;
  /** The owner / server cell repeats the row above and stays blank. */
  blank: 'owner' | 'server' | null;
  onAction: ActionHandler;
};

type TableProps = {
  groups: ContainerGroup[];
  columns: ContainerColumns;
  usage: ContainerLiveUsageIndex;
  admin: boolean;
  emptyLabel: string;
  /** Whether a group shows its rows; null while a search keeps every group open. */
  isOpen: (key: string) => boolean | null;
  onToggle: (key: string) => void;
  onAction: ActionHandler;
};

function rowBlank(group: ContainerGroup, index: number): 'owner' | 'server' | null {
  return repeatsPrevious(group, index) ? mergedColumn(group.grouping) : null;
}

function ContainerTable(props: TableProps) {
  const narrow = useIsNarrow();
  return narrow ? <ContainerCards {...props} /> : <WideContainerTable {...props} />;
}

function WideContainerTable({ groups, columns, usage, admin, emptyLabel, isOpen, onToggle, onAction }: TableProps) {
  const columnCount = 6 + (columns.owner ? 1 : 0) + (columns.server ? 1 : 0) + (columns.gpu ? 1 : 0);
  const empty = groups.every((group) => group.containers.length === 0);
  return (
    <Table className={cn(columns.gpu ? 'min-w-[860px]' : 'min-w-[760px]', '[&_td]:px-2 [&_th]:px-2 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4')}>
      <TableHeader>
        <TableRow>
          <TableHead>名称</TableHead>
          {columns.owner ? <TableHead>所有者</TableHead> : null}
          {columns.server ? <TableHead>服务器</TableHead> : null}
          <TableHead title="已用 / 可用核数">CPU</TableHead>
          <TableHead title="已用 / 规格">内存</TableHead>
          <TableHead title="已用 / 规格">系统盘</TableHead>
          {columns.gpu ? <TableHead title="显卡数 · 显存已用">GPU</TableHead> : null}
          <TableHead title="所有者在该服务器上的授权">剩余</TableHead>
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      {empty ? (
        <TableBody>
          <TableRow>
            <TableCell colSpan={columnCount} className="py-8 text-center text-muted-foreground">
              {emptyLabel}
            </TableCell>
          </TableRow>
        </TableBody>
      ) : groups.map((group, index) => {
        const open = group.grouping === 'none' ? true : isOpen(group.key);
        const rows = open === false ? null : group.containers.map((container, row) => (
          <ContainerTableRow
            key={container.id}
            container={container}
            admin={admin}
            usage={usage}
            columns={columns}
            blank={rowBlank(group, row)}
            onAction={onAction}
          />
        ));
        const header = group.grouping === 'none' ? null : (
          <ContainerGroupHeaderRow
            colSpan={columnCount}
            group={group}
            usage={usage}
            open={open}
            onToggle={() => onToggle(group.key)}
          />
        );
        // Only the last group drops its bottom rule, so every fold keeps a line under it.
        return index === groups.length - 1
          ? <TableBody key={group.key}>{header}{rows}</TableBody>
          : <tbody key={group.key}>{header}{rows}</tbody>;
      })}
    </Table>
  );
}

function ContainerCards({ groups, columns, usage, admin, emptyLabel, isOpen, onToggle, onAction }: TableProps) {
  const empty = groups.every((group) => group.containers.length === 0);
  return (
    <ul className="divide-y" data-testid="container-cards">
      {empty ? (
        <li className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyLabel}</li>
      ) : groups.flatMap((group) => {
        const open = group.grouping === 'none' ? true : isOpen(group.key);
        // A phone card always names its owner and server: cards do not line up like rows.
        const cards = open === false ? [] : group.containers.map((container) => (
          <ContainerCard
            key={container.id}
            container={container}
            admin={admin}
            usage={usage}
            columns={columns}
            onAction={onAction}
          />
        ));
        if (group.grouping === 'none') return cards;
        return [
          <ContainerGroupHeaderItem key={`group:${group.key}`} group={group} usage={usage} open={open} onToggle={() => onToggle(group.key)} />,
          ...cards,
        ];
      })}
    </ul>
  );
}

function ContainerTableRow({ container, admin, usage, columns, blank, onAction }: RowProps) {
  const pending = useResourceMutationPending(container.id);
  const sample = liveSample(container, usage.byContainer.get(container.id));
  const stale = sample !== undefined && usage.staleServers.has(container.serverId);
  return (
    <TableRow>
      <TableCell className="min-w-[7.5rem] whitespace-normal">
        <ContainerName container={container} admin={admin} />
        <p className="mt-0.5 pl-3.5 font-mono text-xs text-muted-foreground">{container.routedIp ?? '等待容器 IP'}</p>
      </TableCell>
      {columns.owner ? (
        <TableCell>{blank === 'owner' ? null : <OwnerRef container={container} />}</TableCell>
      ) : null}
      {columns.server ? (
        <TableCell>
          {blank === 'server' ? null : <ResourceRef kind="server" id={container.serverId} name={container.serverName} />}
        </TableCell>
      ) : null}
      <TableCell>
        <UsageMeter className="w-[4.5rem]" dense reading={compactReading(cpuReading(container, sample))} stale={stale} />
      </TableCell>
      <TableCell>
        <UsageMeter className="w-[4.5rem]" dense reading={compactReading(memoryReading(container, sample))} stale={stale} />
      </TableCell>
      <TableCell>
        <UsageMeter className="w-[4.5rem]" dense reading={compactReading(rootDiskReading(container, sample))} stale={stale} />
      </TableCell>
      {columns.gpu ? (
        <TableCell>
          <UsageMeter className="w-24" dense reading={compactReading(gpuReading(container, sample))} stale={stale} />
        </TableCell>
      ) : null}
      <TableCell>
        <ContainerRemaining access={container.access} />
      </TableCell>
      <TableCell className="text-right">
        <RowActions container={container} admin={admin} pending={pending} onAction={onAction} />
      </TableCell>
    </TableRow>
  );
}

function OwnerRef({ container }: { container: ContainerDto }) {
  if (!container.ownerId) return <>—</>;
  return <ResourceRef kind="user" id={container.ownerId} name={container.ownerDisplayName} username={container.ownerName} />;
}

/** 终端 first (the everyday jump), then the power icons after a hairline. */
function RowActions({
  container,
  admin,
  pending,
  onAction,
}: Pick<RowProps, 'container' | 'admin' | 'onAction'> & { pending: boolean }) {
  return (
    <div className="flex items-center justify-end gap-1">
      <ConsoleShortcut container={container} admin={admin} />
      <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
      <ContainerActionBar
        container={container}
        layout="icons"
        pending={pending}
        onAction={(action) => onAction(action, container)}
      />
    </div>
  );
}

/** A plain running container is just a green dot before its name; anything else adds badges after it. */
function ContainerName({ container, admin }: { container: ContainerDto; admin: boolean }) {
  const detailTo = admin ? '/manage/containers/$containerId' : '/containers/$containerId';
  const label = containerStatusLabel(container.actual.status);
  const badged = hasStatusBadges(container);
  const tone = container.needsAttention
    ? 'bg-destructive'
    : container.actual.status === 'running' ? 'bg-success' : 'bg-muted-foreground/40';
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
      <span
        className={cn('h-2 w-2 shrink-0 rounded-full', tone)}
        title={label}
        {...(badged ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      />
      <Link
        to={detailTo}
        params={{ containerId: container.id }}
        search={{ tab: 'overview' }}
        className="min-w-0 truncate font-medium hover:underline"
      >
        {container.name}
      </Link>
      {badged ? <ContainerStatusBadges container={container} /> : null}
    </div>
  );
}

function hasStatusBadges(container: ContainerDto): boolean {
  return container.actual.status !== 'running'
    || containerStatusPending(container)
    || container.lifecyclePhase !== 'active'
    || container.needsAttention;
}

function ContainerStatusBadges({ container }: { container: ContainerDto }) {
  const status = container.actual.status;
  const statusPending = containerStatusPending(container);
  return (
    <>
      {status !== 'running' || statusPending ? (
        <StatusBadge
          label={containerStatusLabel(status)}
          raw={status}
          pending={statusPending}
          variant={status === 'running' ? 'success' : container.needsAttention ? 'destructive' : 'secondary'}
        />
      ) : null}
      {container.lifecyclePhase !== 'active' ? (
        <StatusBadge
          label={lifecyclePhaseLabel(container.lifecyclePhase)}
          raw={container.lifecyclePhase}
          pending={containerLifecyclePending(container)}
          variant="warning"
        />
      ) : null}
      {container.needsAttention ? <TriangleAlert className="h-3.5 w-3.5 text-destructive" aria-label="需要关注" /> : null}
    </>
  );
}

/** Phone layout: one stacked card per container, power actions always in reach. */
function ContainerCard({ container, admin, usage, columns, onAction }: Omit<RowProps, 'blank'>) {
  const pending = useResourceMutationPending(container.id);
  const sample = liveSample(container, usage.byContainer.get(container.id));
  const stale = sample !== undefined && usage.staleServers.has(container.serverId);
  const gpu = gpuReading(container, sample);
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 pt-1">
          <ContainerName container={container} admin={admin} />
        </div>
        <div className="shrink-0">
          <RowActions container={container} admin={admin} pending={pending} onAction={onAction} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {columns.owner && container.ownerId ? (
          <>
            <OwnerRef container={container} />
            {' · '}
          </>
        ) : null}
        {columns.server ? (
          <>
            <ResourceRef kind="server" id={container.serverId} name={container.serverName} />
            {' · '}
          </>
        ) : null}
        <span className="font-mono">{container.routedIp ?? '等待容器 IP'}</span>
      </p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1">
        <UsageMeter layout="inline" label="CPU" reading={cpuReading(container, sample)} stale={stale} />
        <UsageMeter layout="inline" label="内存" reading={memoryReading(container, sample)} stale={stale} />
        <UsageMeter className="col-span-2" layout="inline" label="系统盘" reading={rootDiskReading(container, sample)} stale={stale} />
        {gpu ? <UsageMeter layout="inline" label="GPU" reading={gpu} stale={stale} /> : null}
        <div className="flex items-center gap-2 text-xs">
          <span className="w-10 shrink-0 text-muted-foreground">剩余</span>
          <ContainerRemaining access={container.access} />
        </div>
      </div>
    </li>
  );
}

/** The 全平台 list's folding, kept in the page URL by its owner. */
export type ContainerListGrouping = {
  value: ContainerGrouping;
  collapsed: ReadonlySet<string>;
  onChange: (value: ContainerGrouping) => void;
  onCollapsedChange: (keys: ReadonlySet<string>) => void;
};

/**
 * Container table with search and a status segment, shared by the user and
 * admin lists. With `grouping` (the admin list) rows fold per server or owner;
 * a search opens every group that has a match.
 */
export function ContainerList({
  containers,
  admin = false,
  grouping,
  onAction,
}: {
  containers: ContainerDto[];
  admin?: boolean;
  grouping?: ContainerListGrouping;
  onAction: ActionHandler;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ContainerStatusFilter>('all');
  const usage = useContainerLiveUsage(admin ? 'all' : 'mine');
  const visible = filterContainers(containers, query, status);
  const searching = query.trim() !== '';
  const by = grouping?.value ?? 'none';
  const groups = groupContainers(visible, by);
  const folding = grouping !== undefined && by !== 'none' && !searching;
  const columns: ContainerColumns = {
    owner: admin && by !== 'owner',
    server: by !== 'server',
    gpu: containers.some((container) => gpuCardCount(container) > 0),
  };
  const toggle = (key: string) => {
    if (!grouping) return;
    const next = new Set(grouping.collapsed);
    if (!next.delete(key)) next.add(key);
    grouping.onCollapsedChange(next);
  };
  return (
    <SectionCard
      flush
      toolbar={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedFilter
              label="按状态筛选"
              value={status}
              onChange={setStatus}
              options={containerStatusOptions(containers)}
            />
            {grouping ? (
              <SegmentedFilter
                label="分组方式"
                value={grouping.value}
                onChange={grouping.onChange}
                options={CONTAINER_GROUPING_OPTIONS}
              />
            ) : null}
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto">
            {folding && grouping && groups.length > 1 ? (
              <FoldAllButton groups={groups} grouping={grouping} />
            ) : null}
            <ListSearch
              className={cn('min-w-0 flex-1 sm:flex-none', admin ? 'sm:w-72' : 'sm:w-64')}
              value={query}
              onChange={setQuery}
              placeholder={admin ? '搜索名称、所有者、服务器、IP' : '搜索名称、服务器、IP'}
            />
          </div>
        </div>
      )}
    >
      <ContainerTable
        groups={groups}
        columns={columns}
        usage={usage}
        admin={admin}
        emptyLabel={searching || status !== 'all' ? '没有符合条件的容器' : '暂无容器'}
        isOpen={(key) => (folding && grouping ? !grouping.collapsed.has(key) : null)}
        onToggle={toggle}
        onAction={onAction}
      />
    </SectionCard>
  );
}

function FoldAllButton({ groups, grouping }: { groups: ContainerGroup[]; grouping: ContainerListGrouping }) {
  const allFolded = groups.every((group) => grouping.collapsed.has(group.key));
  const label = allFolded ? '全部展开' : '全部折叠';
  const Icon = allFolded ? ChevronsUpDown : ChevronsDownUp;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 px-2.5 text-muted-foreground"
      aria-label={label}
      onClick={() => grouping.onCollapsedChange(
        allFolded ? new Set() : new Set([...grouping.collapsed, ...groups.map((group) => group.key)]),
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}
