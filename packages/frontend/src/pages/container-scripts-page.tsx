import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { FileTerminal, Plus, RefreshCw } from 'lucide-react';
import { ContainerScriptStatus, type ContainerScriptDto } from '@nyabase/common';
import { Button } from '../components/ui/button.js';
import { Switch } from '../components/ui/switch.js';
import { Label } from '../components/ui/label.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { ScriptFormDialog } from '../components/container-scripts/script-form-dialog.js';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { SCRIPT_IN_PROGRESS_POLL_MS, scriptInProgress } from '../lib/container-scripts.js';
import { ContainerScriptsTable } from './container-scripts-page/scripts-table.js';

/** 容器脚本: administrator scripts the platform runs as root inside containers, in priority order. */
export default function ContainerScriptsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const scriptsQuery = useQuery({
    queryKey: queryKeys.containerScripts.list,
    queryFn: () => api.get<ContainerScriptDto[]>('/admin/container-scripts'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: (query.state.data ?? []).some(scriptInProgress) ? SCRIPT_IN_PROGRESS_POLL_MS : false,
    }),
  });
  const all = useMemo(
    () => [...(scriptsQuery.data ?? [])].sort((left, right) => left.priority - right.priority),
    [scriptsQuery.data],
  );
  const archivedCount = all.filter((script) => script.status === ContainerScriptStatus.Archived).length;
  const scripts = showArchived ? all : all.filter((script) => script.status !== ContainerScriptStatus.Archived);
  const createButton = (
    <Button onClick={() => setCreating(true)} data-testid="container-script-create">
      <Plus className="h-4 w-4" />新建脚本
    </Button>
  );

  return (
    <Page testId="container-scripts">
      <PageHeader
        title="容器脚本"
        description="以 root 身份在容器内执行的维护脚本；同一容器上按优先级从小到大依次执行。"
        actions={(
          <>
            <Button variant="outline" size="icon" aria-label="刷新容器脚本" onClick={() => { void scriptsQuery.refetch(); }}>
              <RefreshCw className="h-4 w-4" />
            </Button>
            {createButton}
          </>
        )}
      />
      {archivedCount > 0 ? (
        <div className="flex items-center gap-2">
          <Switch id="container-scripts-show-archived" checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor="container-scripts-show-archived" className="text-sm font-normal">
            显示已归档（{archivedCount}）
          </Label>
        </div>
      ) : null}
      <QueryView
        query={scriptsQuery}
        resourceName="容器脚本"
        loadingLabel="加载容器脚本..."
        showEmpty={scripts.length === 0}
        empty={(
          <EmptyState
            icon={FileTerminal}
            title={all.length > 0 ? '没有未归档的脚本' : '暂无容器脚本'}
            description="脚本可以在发布时立即执行、在新容器创建后执行，或在每次开机后执行。"
            action={createButton}
          />
        )}
      >
        {() => <ContainerScriptsTable scripts={scripts} />}
      </QueryView>
      <ScriptFormDialog
        open={creating}
        onOpenChange={setCreating}
        target={{ kind: 'create' }}
        onCreated={(script) => {
          void navigate({ to: '/container-scripts/$scriptId', params: { scriptId: script.id }, search: { tab: 'targets' } });
        }}
      />
    </Page>
  );
}
