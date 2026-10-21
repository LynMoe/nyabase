import { Activity, Cpu, Gauge, HardDrive, History, KeyRound, ListChecks } from 'lucide-react';
import { Capability, type ServerDto } from '@nyabase/common';
import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs.js';
import { PreflightCard } from '../../components/servers/preflight-card.js';
import { NodeMetricsCard } from '../../components/servers/node-metrics-card.js';
import { ServerMetricsPanel } from '../../components/performance/server-metrics-panel.js';
import { PoolsCard } from '../../components/servers/pools-card.js';
import { ServerStorageTab } from '../../components/servers/server-storage-tab.js';
import { ResourceIntentFailures } from '../../components/intents/resource-intent-failures.js';
import { ServerGpuCard } from '../../components/gpu/gpu-sections.js';
import { Field } from '../../components/layout/form-field.js';
import { ConnectCard } from '../../components/servers/connect-card.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { useServerPools } from '../../lib/server-queries.js';
import { useAuthStore } from '../../store/auth.js';
import { preflightStatusLabel, storageOvercommitLabel } from '../../lib/display-labels.js';

export const SERVER_DETAIL_TABS = [
  'overview', 'connect', 'storage', 'preflight', 'metrics', 'gpu', 'activity',
] as const;
export type ServerDetailTab = (typeof SERVER_DETAIL_TABS)[number];

const SERVER_DETAIL_TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['connect', '接入', KeyRound],
  ['storage', '存储', HardDrive],
  ['preflight', '检查', ListChecks],
  ['metrics', '监控', Activity],
  ['gpu', 'GPU', Cpu],
  ['activity', '活动', History],
] as const;

export function ServerDetailTabs({
  server,
  tab,
  onSelectTab,
}: {
  server: ServerDto;
  tab: ServerDetailTab;
  onSelectTab: (tab: ServerDetailTab) => void;
}) {
  const serverId = server.id;
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onSelectTab(value as ServerDetailTab)}
      data-testid="server-detail-tabs"
    >
      <TabsList>
        {SERVER_DETAIL_TAB_ITEMS.map(([key, label, Icon]) => (
          <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`server-tab-${key}`}>
            <Icon className="h-4 w-4" />{label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="overview" className="space-y-6">
        <ServerOverviewTab server={server} onSelectTab={onSelectTab} />
      </TabsContent>
      <TabsContent value="connect" className="space-y-6">
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <ConnectCard server={server} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">客户端证书</CardTitle>
              <CardDescription>
                所有服务器共用一张自动生成的 Incus 客户端证书，在
                <Link to="/servers" hash="client-identity" className="mx-1 underline underline-offset-4">服务器列表</Link>
                查看指纹。
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </TabsContent>
      <TabsContent value="storage" className="space-y-6" data-testid="server-storage-tab">
        <ServerStorageTab serverId={serverId}>
          <PoolsCard server={server} />
        </ServerStorageTab>
      </TabsContent>
      <TabsContent value="preflight">
        <PreflightCard server={server} />
      </TabsContent>
      <TabsContent value="metrics" className="space-y-6">
        {capabilities.includes(Capability.ViewMetricsAll) ? <ServerMetricsPanel serverId={serverId} /> : null}
        <NodeMetricsCard server={server} />
      </TabsContent>
      <TabsContent value="gpu">
        {capabilities.includes(Capability.ManageServers) ? (
          <ServerGpuCard serverId={serverId} active={tab === 'gpu'} />
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">GPU</CardTitle>
              <CardDescription>没有管理此服务器 GPU 的权限</CardDescription>
            </CardHeader>
          </Card>
        )}
      </TabsContent>
      <TabsContent value="activity">
        <ResourceIntentFailures
          listPath={`/intents?scope=all&serverId=${serverId}`}
          enabled={tab === 'activity'}
        />
      </TabsContent>
    </Tabs>
  );
}

function ServerOverviewTab({
  server,
  onSelectTab,
}: {
  server: ServerDto;
  onSelectTab: (tab: 'connect' | 'storage' | 'preflight') => void;
}) {
  const registeredPoolCount = (useServerPools(server.id).data ?? []).filter((pool) => pool.registered).length;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">身份</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label="slug" value={<TechnicalId label="slug" value={server.slug} kind="text" />} />
          <Field label="接入地址" value={<TechnicalId label="接入地址" value={server.apiEndpoint} kind="text" />} />
          <Field label="Incus 版本" value={server.incusVersion ?? '未连接'} />
          <Field label="系统盘池" value={server.systemPoolName ?? server.systemPoolId ?? '未指定'} />
          <Field label="存储超分比例" value={storageOvercommitLabel(server.storageOvercommitRatio)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">接入清单</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            <li>
              <button type="button" className="underline" onClick={() => onSelectTab('connect')}>互信</button>
              {server.incusVersion || server.serverCertFingerprint ? ' · 已连接' : ' · 未连接'}
            </li>
            <li>
              <button type="button" className="underline" onClick={() => onSelectTab('storage')}>存储池</button>
              {` · 已登记 ${registeredPoolCount} 个`}
            </li>
            <li>
              <button type="button" className="underline" onClick={() => onSelectTab('preflight')}>前置检查</button>
              {` · ${preflightStatusLabel(server.preflightStatus)}`}
            </li>
            <li>
              <Link to="/ip-pools" className="underline">IP 池</Link>
              {' · 在 IP 池页把地址段绑定到这台服务器'}
            </li>
          </ol>
        </CardContent>
      </Card>
    </>
  );
}
