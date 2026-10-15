import { useQuery } from '@tanstack/react-query';
import {
  type ContainerDto,
  type EffectiveAccessDto,
  type EffectiveServerAccessDto,
  type EffectiveSharedBackendAccessDto,
  type SharedBackendDto,
  type StorageCapacityDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { QueryView } from '../layout/query-view.js';
import { SectionCard } from '../layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table.js';
import { cn } from '../../lib/utils.js';
import { formatQuotaDimension } from '../../lib/grant-quota.js';
import { formatExtensionGrantSummaries } from '../../extensions/registry.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';

/**
 * What the signed-in user is granted and how much of it is already allocated.
 * Allocation is what containers and volumes reserve, not live usage; live
 * usage is on the 使用情况 page.
 */
export function QuotaSummary() {
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const accessQuery = useQuery({
    queryKey: queryKeys.meAccess,
    queryFn: () => api.get<EffectiveAccessDto>('/me/access'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const backendsQuery = useQuery({
    queryKey: queryKeys.sharedBackends.user,
    queryFn: () => api.get<SharedBackendDto[]>('/shared-backends'),
    enabled: (accessQuery.data?.sharedBackends?.length ?? 0) > 0,
  });

  return (
    <QueryView
        queries={[accessQuery, serversQuery, containersQuery]}
        resourceNames={['授权', '服务器', '容器']}
        loadingLabel="加载额度..."
      >
        {() => (
          <QuotaBody
            servers={serversQuery.data ?? []}
            containers={containersQuery.data ?? []}
            grants={accessQuery.data?.servers ?? []}
            sharedBackends={accessQuery.data?.sharedBackends ?? []}
            backends={backendsQuery.data ?? []}
          />
        )}
      </QueryView>
  );
}

function QuotaBody({
  servers,
  containers,
  grants,
  sharedBackends,
  backends,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
  grants: EffectiveServerAccessDto[];
  sharedBackends: EffectiveSharedBackendAccessDto[];
  backends: SharedBackendDto[];
}) {
  const empty = grants.length === 0 && sharedBackends.length === 0;
  const serverName = new Map(servers.map((server) => [server.id, server.name]));
  return (
    <SectionCard
      title="我的额度"
      description={empty ? undefined : '已分配 = 容器与数据卷占用的规格，不是实时用量。'}
      flush={!empty}
    >
      {empty ? (
        <p className="text-sm text-muted-foreground">
          还没有可用的资源额度。管理员为你分配服务器或共享存储后，额度会显示在这里。
        </p>
      ) : null}
      {grants.length > 0 ? (
        <div data-testid="quota-servers">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>服务器</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>内存</TableHead>
                <TableHead>磁盘</TableHead>
                <TableHead>扩展</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {grants.map((grant) => (
                <ServerQuotaRow
                  key={grant.serverId}
                  grant={grant}
                  name={serverName.get(grant.serverId) ?? grant.serverId}
                  containers={containers.filter((container) => container.serverId === grant.serverId)}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {sharedBackends.length > 0 ? (
        <div data-testid="quota-shared" className={grants.length > 0 ? 'border-t' : undefined}>
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead>共享存储</TableHead>
                <TableHead>已分配 / 额度</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sharedBackends.map((access) => {
                const backend = backends.find((item) => item.id === access.sharedBackendId);
                const name = backend?.displayName ?? backend?.name ?? access.sharedBackendId;
                const disk = formatQuotaDimension(access.limitBytes, access.usedBytes, 'bytes');
                return (
                  <TableRow key={access.sharedBackendId}>
                    <TableCell className="font-medium">{name}</TableCell>
                    <TableCell>
                      <QuotaCell
                        used={disk.used}
                        limit={disk.limit}
                        remaining={disk.remaining}
                        grant={access.limitBytes}
                        consumed={access.usedBytes}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </SectionCard>
  );
}

function ServerQuotaRow({
  grant,
  name,
  containers,
}: {
  grant: EffectiveServerAccessDto;
  name: string;
  containers: ContainerDto[];
}) {
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(grant.serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${grant.serverId}/storage-capacity`),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const cpuUsed = containers.reduce((sum, item) => sum + item.cpuMillis, 0);
  const memUsed = containers.reduce((sum, item) => sum + item.memBytes, 0);
  const diskUsed = capacityQuery.data
    ? capacityQuery.data.usedByRootDisksBytes + capacityQuery.data.usedByLocalVolumesBytes
    : 0;
  const cpu = formatQuotaDimension(grant.cpuMillis, cpuUsed, 'cpu');
  const mem = formatQuotaDimension(grant.memBytes, memUsed, 'bytes');
  const disk = formatQuotaDimension(grant.diskBytes, diskUsed, 'bytes');
  const extensions = formatExtensionGrantSummaries(grant.extensionGrants);
  return (
    <TableRow>
      <TableCell className="font-medium">{name}</TableCell>
      <TableCell>
        <QuotaCell used={cpu.used} limit={cpu.limit} remaining={cpu.remaining} grant={grant.cpuMillis} consumed={cpuUsed} />
      </TableCell>
      <TableCell>
        <QuotaCell used={mem.used} limit={mem.limit} remaining={mem.remaining} grant={grant.memBytes} consumed={memUsed} />
      </TableCell>
      <TableCell>
        {capacityQuery.data ? (
          <QuotaCell used={disk.used} limit={disk.limit} remaining={disk.remaining} grant={grant.diskBytes} consumed={diskUsed} />
        ) : (
          <span className="text-muted-foreground">额度 {disk.limit}</span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {extensions.length > 0 ? extensions.join('、') : '无'}
      </TableCell>
    </TableRow>
  );
}

function QuotaCell({
  used,
  limit,
  remaining,
  grant,
  consumed,
}: {
  used: string;
  limit: string;
  remaining: string;
  grant: number | null;
  consumed: number;
}) {
  const unlimited = grant === null || grant === 0;
  const pct = unlimited || grant <= 0 ? 0 : Math.min(100, Math.round((consumed / grant) * 100));
  return (
    <div className="min-w-[7rem]">
      <p className="text-sm">{used} / {limit}</p>
      {!unlimited ? (
        <>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full', pct >= 90 ? 'bg-destructive' : 'bg-primary')}
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">剩余 {remaining}</p>
        </>
      ) : null}
    </div>
  );
}
