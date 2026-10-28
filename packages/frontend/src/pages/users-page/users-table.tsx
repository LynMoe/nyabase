import { Link, useNavigate } from '@tanstack/react-router';
import type { ServerGrantDto, UserDto, UserServerDto } from '@nyabase/common';
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

/** One server a user holds a grant on; hovering shows the bundle and its effective quotas. */
function ServerGrantBadge({ grant, servers }: { grant: ServerGrantDto; servers: UserServerDto[] }) {
  const server = servers.find((row) => row.id === grant.serverId);
  const phase = expiryPhase(grant.expiresAt);
  return (
    <Hint
      content={(
        <div className="space-y-0.5">
          <p className="font-medium">{serverName(grant.serverId, servers)} · 模板 {grant.bundleName}</p>
          {quotaSummaryParts(grant, server ?? {}).map((part) => <p key={part}>{part}</p>)}
          <p>{dataDiskSummary(grant.storagePools)}</p>
          <p className="text-muted-foreground">到期 {expiryLabel(grant.expiresAt)}</p>
        </div>
      )}
    >
      <Badge
        variant={phase === 'live' ? 'outline' : 'warning'}
        className="px-1.5 py-0 text-[11px] font-normal"
        data-testid={`user-grant-${grant.userId}-${grant.serverId}`}
      >
        {serverName(grant.serverId, servers)}
      </Badge>
    </Hint>
  );
}

/** Users, one compact row each: name, role, status, the servers granted, the administrators' note. */
export function UsersTable({
  users,
  grants,
  servers,
}: {
  users: UserDto[];
  grants: ServerGrantDto[];
  servers: UserServerDto[];
}) {
  const navigate = useNavigate();
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
    <Table className="min-w-[760px]">
      <TableHeader>
        <TableRow>
          <TableHead className="py-2">用户</TableHead>
          <TableHead className="py-2">角色</TableHead>
          <TableHead className="py-2">状态</TableHead>
          <TableHead className="py-2">授权服务器</TableHead>
          <TableHead className="py-2">备注</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {users.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
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
              <Link to="/users/$id" params={{ id: user.id }} className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate font-medium">{user.displayName}</span>
                <span className="font-mono text-xs text-muted-foreground">@{user.username}</span>
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
                  <ServerGrantBadge key={grant.id} grant={grant} servers={servers} />
                ))}
              </div>
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
