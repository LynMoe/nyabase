import { ChevronRight } from 'lucide-react';
import type { ContainerDto } from '@nyabase/common';
import { ResourceRef } from '../refs/resource-ref.js';
import { TableCell, TableRow } from '../ui/table.js';
import { cn } from '../../lib/utils.js';
import { type ContainerGroup, NO_OWNER_GROUP_KEY, summarizeContainerGroup } from '../../lib/container-groups.js';
import type { ContainerLiveUsageIndex } from '../../hooks/use-container-live-usage.js';

type HeaderProps = {
  group: ContainerGroup;
  usage: ContainerLiveUsageIndex;
  /** Null while a search keeps every group open. */
  open: boolean | null;
  onToggle: () => void;
};

/** The fold row above a group in the wide table: the server or owner, then what the group holds. */
export function ContainerGroupHeaderRow({ colSpan, ...props }: HeaderProps & { colSpan: number }) {
  return (
    <TableRow className="bg-muted/25 hover:bg-muted/40" data-testid="container-group">
      <TableCell
        colSpan={colSpan}
        className={cn('py-2', props.open !== null && 'cursor-pointer')}
        onClick={props.open === null ? undefined : props.onToggle}
      >
        <GroupHeading {...props} />
      </TableCell>
    </TableRow>
  );
}

/** The same heading as a list item between the phone cards. */
export function ContainerGroupHeaderItem(props: HeaderProps) {
  return (
    <li
      className={cn('bg-muted/25 px-4 py-2', props.open !== null && 'cursor-pointer')}
      data-testid="container-group"
      onClick={props.open === null ? undefined : props.onToggle}
    >
      <GroupHeading {...props} />
    </li>
  );
}

function GroupHeading({ group, usage, open, onToggle }: HeaderProps) {
  const first = group.containers[0]!;
  const title = groupTitle(group, first);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {open === null ? null : (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? '折叠' : '展开'} ${title}`}
          className="-ml-1 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          onClick={(event) => { event.stopPropagation(); onToggle(); }}
        >
          <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
      )}
      <span className="min-w-0 font-semibold">
        <GroupRef group={group} first={first} />
      </span>
      <GroupSummary group={group} usage={usage} />
    </div>
  );
}

function GroupRef({ group, first }: { group: ContainerGroup; first: ContainerDto }) {
  if (group.grouping === 'server') {
    return <ResourceRef kind="server" id={first.serverId} name={first.serverName} />;
  }
  if (group.key === NO_OWNER_GROUP_KEY) return <span>无所有者</span>;
  return <ResourceRef kind="user" id={first.ownerId} name={first.ownerDisplayName} username={first.ownerName} />;
}

function groupTitle(group: ContainerGroup, first: ContainerDto): string {
  if (group.grouping === 'server') return first.serverName;
  if (group.key === NO_OWNER_GROUP_KEY) return '无所有者';
  return first.ownerDisplayName || first.ownerName || '所有者';
}

/** `19 个容器 · 8 人 · 运行 19 · GPU 7/8 卡`, over the rows the filters left. */
function GroupSummary({ group, usage }: { group: ContainerGroup; usage: ContainerLiveUsageIndex }) {
  const summary = summarizeContainerGroup(group.containers);
  const parts: string[] = [`${summary.total} 个容器`];
  parts.push(group.grouping === 'server' ? `${summary.owners} 人` : `${summary.servers} 台服务器`);
  if (summary.running > 0) parts.push(`运行 ${summary.running}`);
  if (summary.stopped > 0) parts.push(`未运行 ${summary.stopped}`);
  if (summary.gpuCards > 0) {
    const total = group.grouping === 'server' ? usage.gpuCardsByServer.get(group.key) : undefined;
    parts.push(total ? `GPU ${summary.gpuCards}/${total} 卡` : `GPU ${summary.gpuCards} 卡`);
  }
  const gpuTitle = group.grouping === 'server'
    ? 'GPU：本组容器绑定的不同显卡数 / 服务器显卡总数（显卡可被多个容器共享）'
    : 'GPU：该用户的容器绑定的不同显卡数';
  return (
    <span className="text-xs tabular-nums text-muted-foreground" title={summary.gpuCards > 0 ? gpuTitle : undefined}>
      {parts.join(' · ')}
      {summary.attention > 0 ? <span className="text-destructive">{` · 需要处理 ${summary.attention}`}</span> : null}
    </span>
  );
}
