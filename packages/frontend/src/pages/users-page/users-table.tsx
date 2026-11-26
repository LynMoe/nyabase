import { Link, useNavigate } from '@tanstack/react-router';
import {
  ContainerPhase,
  ContainerStatus,
  type ContainerDto,
  type ServerGrantDto,
  type UserDto,
  type UserServerDto,
} from '@nyabase/common';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { Badge } from '../../components/ui/badge.js';
import { Hint } from '../../components/ui/hint.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { expiryLabel, expiryPhase, serverName } from '../../components/grants/use-grant-panel-data.js';
import { dataDiskSummary, quotaSummaryParts } from '../../lib/grant-bundle-form.js';
import { roleLabel, userStatusLabel } from '../../lib/display-labels.js';
import { userDeleting } from '../../lib/in-progress.js';
import { relativeTime } from '../../lib/utils.js';
import { ResourceRef } from '../../components/refs/resource-ref.js';

/** A user's containers on one server (any but those being deleted), and how many of them run. */
interface ContainerTally {
  total: number;
  running: number;
}

const tallyKey = (userId: string, serverId: string) => `${userId}/${serverId}`;

function tallyContainers(containers: ContainerDto[]): Map<string, ContainerTally> {
  const tallies = new Map<string, ContainerTally>();
  for (const container of containers) {
    if (container.lifecyclePhase === ContainerPhase.Deleting) continue;
    const key = tallyKey(container.ownerId, container.serverId);
    const tally = tallies.get(key) ?? { total: 0, running: 0 };
    tally.total += 1;
    if (container.actual.status === ContainerStatus.Running) tally.running += 1;
    tallies.set(key, tally);
  }
  return tallies;
}

/**
 * One server a user holds a grant on; hovering shows the bundle, its effective quotas and the
 * user's containers there. Green when the user has a container on it, amber once the grant expired.
 */
function ServerGrantBadge({
  grant,
  servers,
  containers,
}: {
  grant: ServerGrantDto;
  servers: UserServerDto[];
  /** null: no containers there; undefined: the container list has not loaded. */
  containers: ContainerTally | undefined | null;
}) {
  const server = servers.find((row) => row.id === grant.serverId);
  const phase = expiryPhase(grant.expiresAt);
  const variant = phase !== 'live' ? 'warning' : containers ? 'success' : 'outline';
  return (
    <Hint
      content={(
        <div className="space-y-0.5">
          <p className="font-medium">{serverName(grant.serverId, servers)} · 模板 {grant.bundleName}</p>
          {quotaSummaryParts(grant, server ?? {}).map((part) => <p key={part}>{part}</p>)}
          <p>{dataDiskSummary(grant.dataDisks)}</p>
          {containers !== undefined ? (
            <p>{containers ? `容器 ${containers.total} 个，运行中 ${containers.running} 个` : '没有容器'}</p>
          ) : null}
          <p className="text-muted-foreground">到期 {expiryLabel(grant.expiresAt)}</p>
        </div>
      )}
    >
      <Badge
        variant={variant}
        className="px-1.5 py-0 text-xs font-normal"
        data-testid={`user-grant-${grant.userId}-${grant.serverId}`}
      >
        <ResourceRef kind="server" id={grant.serverId} name={serverName(grant.serverId, servers)} />
      </Badge>
    </Hint>
  );
}

function activityTitle(user: UserDto): string | undefined {
  const lines = [
    user.lastActiveAt ? `最近活跃 ${new Date(user.lastActiveAt).toLocaleString('zh-CN')}` : null,
    user.lastLoginAt ? `最后登录 ${new Date(user.lastLoginAt).toLocaleString('zh-CN')}` : null,
  ].filter((line) => line !== null);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** Users, one compact row each: name, role, status, the servers granted, last activity, the administrators' note. */
export function UsersTable({
  users,
  grants,
  servers,
  containers,
}: {
  users: UserDto[];
  grants: ServerGrantDto[];
  servers: UserServerDto[];
  /** Every user's containers (`scope=all`); undefined until loaded. */
  containers: ContainerDto[] | undefined;
}) {
  const navigate = useNavigate();
  const tallies = containers ? tallyContainers(containers) : undefined;
  const grantsOf = new Map<string, ServerGrantDto[]>();
  for (const grant of grants) {
    const list = grantsOf.get(grant.userId) ?? [];
    list.push(grant);
    grantsOf.set(grant.userId, list);
  }
  const byServerName = (a: ServerGrantDto, b: ServerGrantDto) => (
    serverName(a.serverId, servers).localeCompare(serverName(b.serverId, servers), 'zh-CN')
  );
  return (
    <Table className="min-w-[860px]">
      <TableHeader>
        <TableRow>
          <TableHead className="py-2">用户</TableHead>
          <TableHead className="py-2">角色</TableHead>
          <TableHead className="py-2">状态</TableHead>
          <TableHead className="py-2">授权服务器</TableHead>
          <TableHead className="py-2">最近活跃</TableHead>
          <TableHead className="py-2">备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
              没有符合条件的用户
            </TableCell>
          </TableRow>
        ) : null}
        {users.map((user) => (
          <TableRow
            key={user.id}
            className="cursor-pointer"
            onClick={(event) => {
              // The name is a real link; a click elsewhere on the row opens the user too.
              if ((event.target as HTMLElement).closest('a')) return;
              void navigate({ to: '/users/$id', params: { id: user.id } });
            }}
          >
            <TableCell className="py-2">
              <Link
                to="/users/$id"
                params={{ id: user.id }}
                className="block truncate font-medium"
                title={`@${user.username}`}
              >
                {user.displayName.trim() || user.username}
              </Link>
            </TableCell>
            <TableCell className="py-2">{roleLabel(user.role)}</TableCell>
            <TableCell className="py-2">
              <StatusBadge
                label={userStatusLabel(user.status)}
                pending={userDeleting(user.status)}
                variant={user.status === 'active' ? 'success' : 'secondary'}
              />
            </TableCell>
            <TableCell className="whitespace-normal py-2">
              <div className="flex max-w-[22rem] flex-wrap gap-1">
                {(grantsOf.get(user.id) ?? []).sort(byServerName).map((grant) => (
                  <ServerGrantBadge
                    key={grant.id}
                    grant={grant}
                    servers={servers}
                    containers={tallies ? tallies.get(tallyKey(user.id, grant.serverId)) ?? null : undefined}
                  />
                ))}
              </div>
            </TableCell>
            <TableCell
              className="whitespace-nowrap py-2 text-muted-foreground"
              title={activityTitle(user)}
            >
              {user.lastActiveAt ? relativeTime(user.lastActiveAt) : '—'}
            </TableCell>
            <TableCell className="max-w-[18rem] py-2">
              <p className="truncate text-muted-foreground" title={user.note ?? undefined}>{user.note ?? ''}</p>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
