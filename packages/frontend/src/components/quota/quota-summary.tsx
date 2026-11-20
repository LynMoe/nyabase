import { useQuery } from '@tanstack/react-query';
import {
  formatGpuGrantSummary,
  type ContainerDto,
  type EffectiveAccessDto,
  type EffectiveServerAccessDto,
  type LiveServerAccessDto,
  type EffectiveSharedBackendAccessDto,
  type SharedBackendDto,
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
import { expiryLabel, remainingLabel } from '../grants/use-grant-panel-data.js';
import { formatQuotaDimension, runningMemBytes } from '../../lib/grant-quota.js';
import { sharedUnitPair } from '../../lib/container-usage.js';
import { cpuGrantLabel } from '../../lib/cpu-set.js';
import { poolDisplayName } from '../../lib/data-disks.js';
import { graceServerAccess, liveServerAccess } from '../../lib/effective-access.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { formatBytes } from '../../lib/utils.js';
import { ResourceRef } from '../refs/resource-ref.js';

/**
 * What the signed-in user is granted and how much of it is already taken:
 * memory as allocated by running containers (not live usage, which is on the
 * 使用情况 page); the disk total as system disks 已分配 plus the data on the
 * data disks (the platform sizes those volumes itself), the two sharing it;
 * shared storage as the data on the volume.
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
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>服务器</TableHead>
                <TableHead>CPU</TableHead>
                <TableHead>内存（运行中占用）</TableHead>
                <TableHead>磁盘（系统盘与数据盘共用）</TableHead>
                <TableHead>GPU</TableHead>
                <TableHead>到期</TableHead>
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
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead>共享存储</TableHead>
                <TableHead>已用 / 额度</TableHead>
                <TableHead>到期</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sharedBackends.map((access) => {
                const backend = backends.find((item) => item.id === access.sharedBackendId);
                const name = backend?.displayName ?? backend?.name ?? access.sharedBackendId;
                const disk = formatQuotaDimension(access.limitBytes, access.usedBytes);
                return (
                  <TableRow key={access.sharedBackendId}>
                    <TableCell className="font-medium">
                      <ResourceRef kind="shared-backend" id={access.sharedBackendId} name={name} />
                    </TableCell>
                    <TableCell>
                      <QuotaCell
                        used={disk.used}
                        limit={disk.limit}
                        remaining={disk.remaining}
                        grant={access.limitBytes}
                        consumed={access.usedBytes}
                      />
                    </TableCell>
                    <TableCell><QuotaExpiry expiresAt={access.expiresAt} /></TableCell>
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
  const memUsed = runningMemBytes(containers);
  const mem = formatQuotaDimension(grant.memBytes, memUsed);
  const gpu = formatGpuGrantSummary(grant.gpuPciAddresses);
  return (
    <TableRow>
      <TableCell className="font-medium"><ResourceRef kind="server" id={grant.serverId} name={name} /></TableCell>
      <TableCell>
        <p className="min-w-[5rem] text-sm tabular-nums" data-testid="quota-cpu">{cpuGrantLabel(grant)}</p>
      </TableCell>
      <TableCell>
        <QuotaCell used={mem.used} limit={mem.limit} remaining={mem.remaining} grant={grant.memBytes} consumed={memUsed} />
      </TableCell>
      <TableCell>
        <DiskQuota grant={grant} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {gpu ?? '无'}
      </TableCell>
      <TableCell><QuotaExpiry expiresAt={grant.expiresAt} /></TableCell>
    </TableRow>
  );
}

function QuotaExpiry({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span className="text-muted-foreground">永久</span>;
  const remaining = remainingLabel(expiresAt);
  return (
    <div className="tabular-nums" data-testid="quota-expiry">
      <p>{expiryLabel(expiresAt)}</p>
      <p className="text-xs text-muted-foreground">{remaining ? `剩余 ${remaining}` : '已到期'}</p>
    </div>
  );
}

/**
 * The disk total: one meter of system disks 已分配 plus the data on the data
 * disks, then the split, the system-disk ceiling (and what a new system disk
 * may still take under it), and each data disk with its data and ceiling.
 */
function DiskQuota({ grant }: { grant: LiveServerAccessDto }) {
  const poolsQuery = useQuery({
    queryKey: queryKeys.servers.pools(grant.serverId, 'mine'),
    queryFn: () => api.get<StoragePoolDto[]>(`/servers/${grant.serverId}/storage-pools`),
    enabled: grant.dataDisks.length > 0,
  });
  const nameOf = (poolId: string) => {
    const row = poolsQuery.data?.find((item) => item.id === poolId);
    return row ? poolDisplayName(row) : truncateId(poolId);
  };
  const data = grant.dataDisks.reduce((sum, disk) => sum + disk.usedBytes, 0);
  const consumed = grant.rootDiskCommittedBytes + data;
  const disk = formatQuotaDimension(grant.diskBytes, consumed);
  return (
    <div className="space-y-1" data-testid="quota-disk">
      <QuotaCell used={disk.used} limit={disk.limit} remaining={disk.remaining} grant={grant.diskBytes} consumed={consumed} />
      <p className="text-xs text-muted-foreground tabular-nums">
        系统盘已分配 {formatBytes(grant.rootDiskCommittedBytes)} · 数据盘数据 {formatBytes(data)}
      </p>
      {grant.rootDiskBytes !== null ? (
        <p className="text-xs text-muted-foreground tabular-nums">
          系统盘上限 {formatBytes(grant.rootDiskBytes)}，还可分配 {formatBytes(grant.rootDiskAvailableBytes)}
        </p>
      ) : null}
      {grant.dataDisks.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground tabular-nums" data-testid="quota-data-disks">
          {grant.dataDisks.map((item) => (
            <li key={item.poolId}>
              {nameOf(item.poolId)} 数据 {formatBytes(item.usedBytes)}
              {item.capBytes === null ? '' : ` / 上限 ${formatBytes(item.capBytes)}`}
            </li>
          ))}
        </ul>
      ) : null}
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
