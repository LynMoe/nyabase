import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import {
  formatGpuGrantSummary,
  type ContainerDto,
  type EffectiveAccessDto,
  type EffectiveSharedBackendAccessDto,
  type GraceServerAccessDto,
  type LiveServerAccessDto,
  type SharedBackendDto,
  type StoragePoolDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { QueryView } from '../layout/query-view.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js';
import { truncateId } from '../refs/technical-id.js';
import { expiryLabel, remainingLabel } from '../grants/use-grant-panel-data.js';
import { formatQuotaDimension, runningMemBytes } from '../../lib/grant-quota.js';
import { cpuGrantLabel } from '../../lib/cpu-set.js';
import { poolDisplayName } from '../../lib/data-disks.js';
import { graceServerAccess, liveServerAccess } from '../../lib/effective-access.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { cn, formatBytes } from '../../lib/utils.js';

/**
 * 额度明细 on 概览, folded by default (open when reached through `#quota`):
 * per server the CPU, memory allocated to running containers, the disk total
 * (system disks as committed plus the data on the data disks), GPUs and
 * expiry; then shared storage. Plain numbers, no meters.
 */
export function QuotaSummary() {
  const [open, setOpen] = useState(() => typeof window !== 'undefined' && window.location.hash === '#quota');
  return (
    <section className="rounded-lg border bg-card" data-testid="quota-details">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-5 py-3 text-left text-sm font-semibold"
      >
        <ChevronRight aria-hidden className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
        额度明细
      </button>
      {open ? <QuotaDetails /> : null}
    </section>
  );
}

function QuotaDetails() {
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
    <div className="border-t">
      <QueryView
        queries={[accessQuery, serversQuery, containersQuery]}
        resourceNames={['授权', '服务器', '容器']}
        loadingLabel="加载额度..."
      >
        {() => (
          <QuotaTable
            servers={serversQuery.data ?? []}
            containers={containersQuery.data ?? []}
            access={accessQuery.data ?? { servers: [], sharedBackends: [] }}
            backends={backendsQuery.data ?? []}
          />
        )}
      </QueryView>
    </div>
  );
}

function QuotaTable({
  servers,
  containers,
  access,
  backends,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
  access: EffectiveAccessDto;
  backends: SharedBackendDto[];
}) {
  const live = liveServerAccess(access.servers);
  const grace = graceServerAccess(access.servers);
  const serverName = new Map(servers.map((server) => [server.id, server.name]));
  if (live.length === 0 && grace.length === 0 && access.sharedBackends.length === 0) {
    return <p className="px-5 py-4 text-sm text-muted-foreground">暂无额度</p>;
  }
  return (
    <Table className="min-w-[820px]" data-testid="quota-servers">
      <TableHeader>
        <TableRow>
          <TableHead className="pl-5">服务器</TableHead>
          <TableHead>CPU</TableHead>
          <TableHead>内存 已分配 / 额度</TableHead>
          <TableHead>磁盘 已用 / 额度</TableHead>
          <TableHead>GPU</TableHead>
          <TableHead className="pr-5">到期</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {live.map((grant) => (
          <ServerQuotaRow
            key={grant.serverId}
            grant={grant}
            name={serverName.get(grant.serverId) ?? truncateId(grant.serverId)}
            containers={containers.filter((container) => container.serverId === grant.serverId)}
          />
        ))}
        {grace.map((grant) => (
          <GraceRow key={grant.serverId} grant={grant} name={serverName.get(grant.serverId) ?? truncateId(grant.serverId)} />
        ))}
        {access.sharedBackends.map((grant) => (
          <SharedBackendRow key={grant.sharedBackendId} grant={grant} backends={backends} />
        ))}
      </TableBody>
    </Table>
  );
}

function ServerQuotaRow({ grant, name, containers }: { grant: LiveServerAccessDto; name: string; containers: ContainerDto[] }) {
  const mem = formatQuotaDimension(grant.memBytes, runningMemBytes(containers));
  return (
    <TableRow className="align-top">
      <TableCell className="pl-5 font-medium">{name}</TableCell>
      <TableCell className="tabular-nums" data-testid="quota-cpu">{cpuGrantLabel(grant)}</TableCell>
      <TableCell className="tabular-nums">{mem.used} / {mem.limit}</TableCell>
      <TableCell><DiskQuota grant={grant} /></TableCell>
      <TableCell>{formatGpuGrantSummary(grant.gpuPciAddresses) ?? '无'}</TableCell>
      <TableCell className="pr-5"><QuotaExpiry expiresAt={grant.expiresAt} /></TableCell>
    </TableRow>
  );
}

function GraceRow({ grant, name }: { grant: GraceServerAccessDto; name: string }) {
  return (
    <TableRow className="align-top" data-testid="quota-grace">
      <TableCell className="pl-5 font-medium">{name}</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="pr-5 text-warning tabular-nums">
        <p>宽限中</p>
        <p className="text-xs">{new Date(grant.purgeAt).toLocaleString('zh-CN')} 清除</p>
      </TableCell>
    </TableRow>
  );
}

function SharedBackendRow({ grant, backends }: { grant: EffectiveSharedBackendAccessDto; backends: SharedBackendDto[] }) {
  const backend = backends.find((item) => item.id === grant.sharedBackendId);
  const disk = formatQuotaDimension(grant.limitBytes, grant.usedBytes);
  return (
    <TableRow className="align-top" data-testid="quota-shared">
      <TableCell className="pl-5 font-medium">共享存储 {backend?.displayName ?? backend?.name ?? truncateId(grant.sharedBackendId)}</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="tabular-nums">{disk.used} / {disk.limit}</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell className="pr-5"><QuotaExpiry expiresAt={grant.expiresAt} /></TableCell>
    </TableRow>
  );
}

function QuotaExpiry({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span>永久</span>;
  const remaining = remainingLabel(expiresAt);
  return (
    <div className="tabular-nums" data-testid="quota-expiry">
      <p>{expiryLabel(expiresAt)}</p>
      <p className="text-xs text-muted-foreground">{remaining ? `剩余 ${remaining}` : '已到期'}</p>
    </div>
  );
}

/** The disk total: system disks as committed plus the data on each data disk, with their ceilings. */
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
  const disk = formatQuotaDimension(grant.diskBytes, grant.rootDiskCommittedBytes + data);
  const parts = [
    `系统盘 ${formatBytes(grant.rootDiskCommittedBytes)}${grant.rootDiskBytes === null ? '' : ` / 上限 ${formatBytes(grant.rootDiskBytes)}`}`,
    ...grant.dataDisks.map((item) =>
      `${nameOf(item.poolId)} ${formatBytes(item.usedBytes)}${item.capBytes === null ? '' : ` / 上限 ${formatBytes(item.capBytes)}`}`),
  ];
  return (
    <div className="space-y-0.5" data-testid="quota-disk">
      <p className="tabular-nums">{disk.used} / {disk.limit}</p>
      <p className="text-xs text-muted-foreground tabular-nums" data-testid="quota-data-disks">{parts.join(' · ')}</p>
    </div>
  );
}
