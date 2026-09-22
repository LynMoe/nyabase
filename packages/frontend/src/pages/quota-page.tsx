import { useQuery } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import {
  type ContainerDto,
  type EffectiveAccessDto,
  type EffectiveServerAccessDto,
  type EffectiveSharedBackendAccessDto,
  type SharedBackendDto,
  type StorageCapacityDto,
  type UserServerDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { cn } from '../lib/utils.js';
import { formatQuotaDimension } from '../lib/grant-quota.js';
import { formatExtensionGrantSummaries } from '../extensions/registry.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';

export default function QuotaPage() {
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
    <Page testId="quota">
      <PageHeader title="配额" />
      <QueryView
        queries={[accessQuery, serversQuery, containersQuery]}
        resourceNames={['授权', '服务器', '容器']}
        loadingLabel="加载配额..."
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
    </Page>
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
  if (grants.length === 0 && sharedBackends.length === 0) {
    return (
      <EmptyState
        icon={Gauge}
        title="当前没有任何资源授权。"
        description="管理员完成服务器或共享存储授权后，额度会显示在这里。"
      />
    );
  }
  const serverName = new Map(servers.map((server) => [server.id, server.name]));
  return (
    <div className="space-y-4">
      {grants.length > 0 ? (
        <SectionCard
          title="服务器"
          flush
          testId="quota-servers"
        >
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
        </SectionCard>
      ) : null}
      {sharedBackends.length > 0 ? (
        <SectionCard
          title="共享存储"
          flush
          testId="quota-shared"
        >
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead>后端</TableHead>
                <TableHead>已预订 / 额度</TableHead>
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
        </SectionCard>
      ) : null}
    </div>
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
