import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Box, Plus, Server, TriangleAlert } from 'lucide-react';
import type { ContainerDto, UserServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { SummaryCard } from '../components/dashboard/summary-card.js';
import { CreateContainerDialog } from '../components/containers/create-container-dialog.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { QuotaSummary } from '../components/quota/quota-summary.js';
import { SshKeyNotice } from '../components/ssh/ssh-key-notice.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { useMySshKeys } from '../hooks/use-my-ssh-keys.js';
import { Button } from '../components/ui/button.js';
import { containerInProgress } from '../lib/in-progress.js';
import { queryPollInterval, refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { queryKeys } from '../lib/query-keys.js';

export default function DashboardPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.user,
    queryFn: () => api.get<UserServerDto[]>('/servers'),
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 30_000 }),
  });
  const containersQuery = useQuery({
    queryKey: queryKeys.containers.userList,
    queryFn: () => api.get<ContainerDto[]>('/containers'),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 15_000,
      isSettled: (containers) => containers.every((container) => !containerInProgress(container)),
    }),
  });

  return (
    <Page testId="incus-resource-dashboard">
      <PageHeader
        title="概览"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />新建容器
          </Button>
        }
      />
      <QueryView
        queries={[serversQuery, containersQuery]}
        resourceNames={['服务器', '容器']}
        loadingLabel="加载概览..."
      >
        {() => (
          <DashboardBody
            servers={serversQuery.data ?? []}
            containers={containersQuery.data ?? []}
          />
        )}
      </QueryView>
      <CreateContainerDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function DashboardBody({
  servers,
  containers,
}: {
  servers: UserServerDto[];
  containers: ContainerDto[];
}) {
  const running = containers.filter((container) => container.actual.status === 'running').length;
  const attention = containers.filter((container) => container.needsAttention).length;
  const online = servers.filter((server) => server.status === 'online').length;
  const sshKeys = useMySshKeys();

  return (
    <>
      {sshKeys.missing ? <SshKeyNotice /> : null}
      {attention > 0 ? (
        <Alert variant="warning" data-testid="dashboard-attention">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription>
            {attention} 个容器的操作失败，需要处理。
            {' '}
            <Link to="/containers" className="font-medium underline underline-offset-4">查看容器</Link>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <SummaryCard
          icon={Box}
          label="容器"
          value={String(running)}
          detail={`运行中 · 共 ${containers.length} 个`}
          to="/containers"
        />
        <SummaryCard
          icon={Server}
          label="服务器"
          value={`${online} / ${servers.length}`}
          detail="在线 / 可用"
        />
      </div>

      <section id="quota" className="scroll-mt-6">
        <QuotaSummary />
      </section>
    </>
  );
}
