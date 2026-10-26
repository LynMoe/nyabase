import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { RefreshCw, Unplug } from 'lucide-react';
import type { SshProxyHostKeySummaryDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Tabs, TabsContent } from '../components/ui/tabs.js';
import { SshSessionList } from '../components/ssh-sessions/ssh-session-list.js';
import { SshSessionStats } from '../components/ssh-sessions/ssh-session-stats.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ACCESS } from '../lib/route-access.js';
import { useHasRole } from '../lib/use-role.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { useSshProxyMutations } from './ssh-proxy-page/use-ssh-proxy-mutations.js';
import { RefusalsSection } from './ssh-proxy-page/refusals-section.js';
import { parseSshProxyTab, SshProxyTabsList, visibleSshProxyTab } from './ssh-proxy-page/tabs.js';
import {
  emptyStatus,
  formatTime,
  HostKeySection,
  type SshProxyAdminStatus,
  SshStatusSections,
} from './ssh-proxy-page/status-sections.js';

const routeApi = getRouteApi('/ssh-proxy/');

export default function SshProxyPage() {
  const navigate = useNavigate({ from: '/ssh-proxy/' });
  const canViewStatus = useHasRole(ACCESS.sshProxyOps);
  const tab = visibleSshProxyTab(routeApi.useSearch().tab, canViewStatus);
  const canManageSettings = canViewStatus;
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const statusQuery = useQuery({
    queryKey: queryKeys.sshProxy.status,
    queryFn: () => api.get<SshProxyAdminStatus>('/admin/ssh-proxy/status'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: 1_000,
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
    enabled: canViewStatus,
  });
  const hostKeyQuery = useQuery({
    queryKey: queryKeys.sshProxy.hostKey,
    queryFn: () => api.get<SshProxyHostKeySummaryDto>('/admin/ssh-proxy/host-key'),
    enabled: canManageSettings,
  });
  const { data, isFetching, refetch } = statusQuery;
  const { isFetching: hostKeyFetching, refetch: refetchHostKey } = hostKeyQuery;

  const { disconnectAll, rotateHostKey, resetHostAuthorities } = useSshProxyMutations({
    onDisconnected: () => setDisconnectOpen(false),
    onRotated: () => setRotateOpen(false),
    onAuthoritiesReset: () => setResetOpen(false),
  });

  const status = data ?? emptyStatus;
  const statusDescription = !canViewStatus
    ? undefined
    : statusQuery.isError
      ? '代理状态加载失败'
      : status.updatedAt ? `最后更新 ${formatTime(status.updatedAt)}` : '等待代理上报实时状态';

  return (
    <Page>
      <PageHeader
        title="SSH 代理"
        description={statusDescription}
        actions={
          <>
            {canViewStatus && (
              <Button variant="outline" size="icon" aria-label="刷新 SSH 代理状态" onClick={() => { void refetch(); }} disabled={isFetching}>
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              </Button>
            )}
            {canManageSettings && (
              <Button
                variant="outline-destructive"
                disabled={(canViewStatus && Boolean(data) && status.activeConnections === 0) || disconnectAll.isPending}
                onClick={() => setDisconnectOpen(true)}
              >
                <Unplug className="h-4 w-4" />
                断开全部
              </Button>
            )}
          </>
        }
      />

      <Tabs
        value={tab}
        onValueChange={(value) => {
          void navigate({ search: { tab: parseSshProxyTab(value) }, replace: true });
        }}
      >
        <SshProxyTabsList canOperate={canViewStatus} />
        <TabsContent value="live" className="space-y-6">
          {canViewStatus && (
            <QueryView query={statusQuery} resourceName="SSH 代理状态" loadingLabel="加载 SSH 代理状态...">
              {(loaded) => <SshStatusSections status={loaded} />}
            </QueryView>
          )}
          {canManageSettings && (
            <HostKeySection
              query={hostKeyQuery}
              fetching={hostKeyFetching}
              rotating={rotateHostKey.isPending}
              onRefresh={() => { void refetchHostKey(); }}
              onRotate={() => setRotateOpen(true)}
              resettingAuthorities={resetHostAuthorities.isPending}
              onResetAuthorities={() => setResetOpen(true)}
            />
          )}
        </TabsContent>
        <TabsContent value="history" className="space-y-3">
          {tab === 'history' ? (
            <SshSessionList
              scope="all"
              description="经 SSH 代理的每一条认证通过的连接，以及它打开（或被拒绝）的每个通道。点一行查看通道明细。"
            />
          ) : null}
        </TabsContent>
        <TabsContent value="stats">
          {tab === 'stats' ? <SshSessionStats scope="all" /> : null}
        </TabsContent>
        <TabsContent value="refusals">
          {tab === 'refusals' && canViewStatus ? <RefusalsSection /> : null}
        </TabsContent>
      </Tabs>

      {canManageSettings && (
        <ConfirmDialog
          open={disconnectOpen}
          onOpenChange={setDisconnectOpen}
          title="断开所有 SSH 代理会话？"
          description={`${canViewStatus && data ? `当前有 ${status.activeConnections} 个活跃连接。` : '当前连接数不可见或尚未加载。'} 确认后会向所有在线 SSH 代理实例发送断开命令。`}
          confirmLabel="断开全部"
          pendingLabel="断开全部"
          pending={disconnectAll.isPending}
          onConfirm={() => disconnectAll.mutate()}
        />
      )}
      {canManageSettings && (
        <ConfirmDialog
          open={rotateOpen}
          onOpenChange={setRotateOpen}
          title="轮换 SSH 主机密钥？"
          description="轮换后所有客户端将失去对当前主机密钥的信任，需要更新 known_hosts 后才能再次连接。确认继续？"
          confirmLabel="确认轮换"
          pendingLabel="确认轮换"
          pending={rotateHostKey.isPending}
          onConfirm={() => rotateHostKey.mutate()}
        />
      )}
      {canManageSettings && (
        <ConfirmDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          title="重置所有容器主机证书 CA？"
          description="只在 ssh.keyEncryptionSecret 丢失、容器证书无法再签发时使用。每个用户都会得到新的 CA，所有容器重新签发主机证书；用户需要到个人资料页重新复制 known_hosts 中的 @cert-authority 行。"
          confirmLabel="确认重置"
          pendingLabel="确认重置"
          pending={resetHostAuthorities.isPending}
          onConfirm={() => resetHostAuthorities.mutate()}
        />
      )}
    </Page>
  );
}
