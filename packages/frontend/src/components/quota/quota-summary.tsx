import { useQuery } from '@tanstack/react-query';
import {
  formatGpuGrantSummary,
  type ContainerDto,
  type EffectiveAccessDto,
  type EffectiveServerAccessDto,
  type LiveServerAccessDto,
  type EffectiveSharedBackendAccessDto,
  type SharedBackendDto,
  type StorageCapacityDto,
  type StoragePoolDto,
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
import { UsageMeter } from '../performance/usage-meter.js';
import { truncateId } from '../refs/technical-id.js';
import { formatQuotaDimension, runningMemBytes } from '../../lib/grant-quota.js';
import { sharedUnitPair } from '../../lib/container-usage.js';
import { cpuGrantLabel } from '../../lib/cpu-set.js';
import { graceServerAccess, liveServerAccess } from '../../lib/effective-access.js';
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
  grants: effective,
  sharedBackends,
  backends,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
  grants: EffectiveServerAccessDto[];
  sharedBackends: EffectiveSharedBackendAccessDto[];
  backends: SharedBackendDto[];
}) {
  const grants = liveServerAccess(effective);
  const lapsed = graceServerAccess(effective);
  const empty = grants.length === 0 && sharedBackends.length === 0 && lapsed.length === 0;
  const serverName = new Map(servers.map((server) => [server.id, server.name]));
  return (
    <SectionCard
      title="我的额度"
      flush={!empty}
    >
      {empty ? (
        <p className="text-sm text-muted-foreground">暂无资源额度</p>
      ) : null}
      {lapsed.length > 0 ? (
        <div data-testid="quota-grace" className="space-y-1 border-b px-4 py-3 text-sm">
          {lapsed.map((grant) => (
            <p key={grant.serverId} className="text-muted-foreground">
              {serverName.get(grant.serverId) ?? grant.serverId} 宽限中 · {new Date(grant.purgeAt).toLocaleString('zh-CN')} 清除
            </p>
          ))}
        </div>
      ) : null}
      {grants.length > 0 ? (
        <div data-testid="quota-servers">
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>服务器</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>内存（运行中占用）</TableHead>
                <TableHead>系统盘</TableHead>
                <TableHead>数据盘</TableHead>
                <TableHead>GPU</TableHead>
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
                const disk = formatQuotaDimension(access.limitBytes, access.usedBytes);
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
  grant: LiveServerAccessDto;
  name: string;
  containers: ContainerDto[];
}) {
  const capacityQuery = useQuery({
    queryKey: queryKeys.storageCapacity(grant.serverId),
    queryFn: () => api.get<StorageCapacityDto>(`/servers/${grant.serverId}/storage-capacity`),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const memUsed = runningMemBytes(containers);
  const capacity = capacityQuery.data;
  const rootUsed = capacity?.usedByRootDisksBytes ?? 0;
  const mem = formatQuotaDimension(grant.memBytes, memUsed);
  const root = formatQuotaDimension(grant.rootDiskBytes, rootUsed);
  const gpu = formatGpuGrantSummary(grant.gpuPciAddresses);
  return (
    <TableRow>
      <TableCell className="font-medium">{name}</TableCell>
      <TableCell>
        <p className="min-w-[5rem] text-sm tabular-nums" data-testid="quota-cpu">{cpuGrantLabel(grant)}</p>
      </TableCell>
      <TableCell>
        <QuotaCell used={mem.used} limit={mem.limit} remaining={mem.remaining} grant={grant.memBytes} consumed={memUsed} />
      </TableCell>
      <TableCell>
        {capacity ? (
          <QuotaCell used={root.used} limit={root.limit} remaining={root.remaining} grant={grant.rootDiskBytes} consumed={rootUsed} />
        ) : (
          <span className="text-muted-foreground">额度 {root.limit}</span>
        )}
      </TableCell>
      <TableCell>
        <DataDiskQuotas grant={grant} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {gpu ?? '无'}
      </TableCell>
    </TableRow>
  );
}

/** One meter per pool the user holds a data-disk quota on. */
function DataDiskQuotas({ grant }: { grant: LiveServerAccessDto }) {
  const poolsQuery = useQuery({
    queryKey: queryKeys.volumeForm.pools(grant.serverId),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${grant.serverId}/storage-pools`),
    enabled: grant.storagePools.length > 0,
  });
  if (grant.storagePools.length === 0) return <span className="text-muted-foreground">无</span>;
  return (
    <div className="space-y-2" data-testid="quota-data-disks">
      {grant.storagePools.map((pool) => {
        const disk = formatQuotaDimension(pool.limitBytes, pool.usedBytes);
        const row = poolsQuery.data?.find((item) => item.id === pool.poolId);
        const name = row ? (row.displayName ?? row.incusName) : truncateId(pool.poolId);
        return (
          <div key={pool.poolId} className="space-y-0.5">
            <p className="text-xs text-muted-foreground">{name}</p>
            <QuotaCell used={disk.used} limit={disk.limit} remaining={disk.remaining} grant={pool.limitBytes} consumed={pool.usedBytes} />
          </div>
        );
      })}
    </div>
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
  const unlimited = grant === null;
  const pair = sharedUnitPair(used, limit);
  return (
    <UsageMeter
      className="w-36"
      reading={{ used: pair.used, total: pair.total, ratio: unlimited || grant <= 0 ? null : consumed / grant }}
      detail={unlimited ? undefined : `剩余 ${remaining}`}
    />
  );
}
