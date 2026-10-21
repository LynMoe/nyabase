import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Unplug } from 'lucide-react';
import { Capability, type SshProxyHostKeySummaryDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { useAuthStore } from '../store/auth.js';
import { canViewSshProxyStatus } from '../lib/ssh-proxy-access.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';
import { useSshProxyMutations } from './ssh-proxy-page/use-ssh-proxy-mutations.js';
import { HostKeySection } from './ssh-proxy-page/status-sections.js';
import {
  SshStatusSections,
  emptyStatus,
  formatTime,
  type SshProxyAdminStatus,
} from './ssh-proxy-page/status-sections.js';

export default function SshProxyPage() {
  const user = useAuthStore((state) => state.user);
  const canViewStatus = canViewSshProxyStatus(user?.capabilities ?? []);
  const canManageSettings = user?.capabilities.includes(Capability.ManageSystemSettings) ?? false;
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [rotateOpen, setRotateOpen] = useState(false);
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

  const { disconnectAll, rotateHostKey } = useSshProxyMutations({
    onDisconnected: () => setDisconnectOpen(false),
    onRotated: () => setRotateOpen(false),
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
              <Button variant="outline" size="icon" aria-label="刷新 SSH 代理状态" onClick={() => refetch()} disabled={isFetching}>
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
          onRefresh={() => refetchHostKey()}
          onRotate={() => setRotateOpen(true)}
        />
      )}

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
    </Page>
  );
}
