import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Boxes, FileCode, History, ListChecks } from 'lucide-react';
import type { ContainerScriptDto } from '@nyabase/common';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { ScriptStatusBadge, TriggerBadges } from '../components/container-scripts/script-badges.js';
import { ScriptVersionView } from '../components/container-scripts/script-version-view.js';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { parseContainerScriptDetailTab } from '../lib/detail-tabs.js';
import { SCRIPT_IN_PROGRESS_POLL_MS, scriptInProgress } from '../lib/container-scripts.js';
import { PausedBanner, ScriptActions, ScriptSummaryCard } from './container-script-detail-page/script-header.js';
import { ScriptTargetsTab } from './container-script-detail-page/targets-tab.js';
import { ScriptRunsTab } from './container-script-detail-page/runs-tab.js';
import { ScriptVersionsTab } from './container-script-detail-page/versions-tab.js';

const routeApi = getRouteApi('/container-scripts/$scriptId');

const TAB_ITEMS = [
  ['targets', '容器', Boxes],
  ['runs', '执行记录', History],
  ['versions', '版本', ListChecks],
  ['script', '当前脚本', FileCode],
] as const;

function ScriptTitle({ script }: { script: ContainerScriptDto }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>{script.name}</span>
      <span className="font-mono text-sm font-normal text-muted-foreground" title="优先级：越小越先执行">#{script.priority}</span>
      <ScriptStatusBadge script={script} />
      <TriggerBadges script={script} version={script.current} />
    </span>
  );
}

/** One container script: its progress per container, runs, versions and current content. */
export default function ContainerScriptDetailPage() {
  const { scriptId } = routeApi.useParams();
  const { tab, container } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/container-scripts/$scriptId' });
  const scriptQuery = useQuery({
    queryKey: queryKeys.containerScripts.detail(scriptId),
    queryFn: () => api.get<ContainerScriptDto>(`/admin/container-scripts/${scriptId}`),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: scriptInProgress(query.state.data) ? SCRIPT_IN_PROGRESS_POLL_MS : false,
    }),
  });
  const script = scriptQuery.data;
  const live = scriptInProgress(script);

  return (
    <Page testId="container-script-detail">
      <PageHeader
        title={script ? <ScriptTitle script={script} /> : '容器脚本'}
        description={script?.description || undefined}
        crumbs={[
          { label: '容器脚本', to: '/container-scripts' },
          { label: script?.name ?? '…' },
        ]}
        actions={script ? <ScriptActions script={script} /> : undefined}
      />
      <QueryView
        query={scriptQuery}
        resourceName="容器脚本"
        loadingLabel="加载容器脚本..."
        onBack={() => window.history.back()}
      >
        {(loaded) => (
          <>
            <PausedBanner script={loaded} />
            <ScriptSummaryCard script={loaded} />
            <Tabs
              value={tab}
              onValueChange={(value) => {
                void navigate({ search: (prev) => ({ ...prev, tab: parseContainerScriptDetailTab(value) }), replace: true });
              }}
              data-testid="container-script-tabs"
            >
              <TabsList className="h-auto w-full flex-nowrap justify-start overflow-x-auto">
                {TAB_ITEMS.map(([key, label, Icon]) => (
                  <TabsTrigger key={key} value={key} className="gap-1.5">
                    <Icon className="h-4 w-4" />{label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="targets">
                {tab === 'targets' ? (
                  <ScriptTargetsTab
                    script={loaded}
                    live={live}
                    onShowRuns={(containerId) => {
                      void navigate({ search: { tab: 'runs', container: containerId } });
                    }}
                  />
                ) : null}
              </TabsContent>
              <TabsContent value="runs">
                {tab === 'runs' ? (
                  <ScriptRunsTab
                    script={loaded}
                    containerId={container}
                    live={live}
                    onContainerChange={(containerId) => {
                      void navigate({ search: (prev) => ({ ...prev, container: containerId }), replace: true });
                    }}
                  />
                ) : null}
              </TabsContent>
              <TabsContent value="versions">
                {tab === 'versions' ? <ScriptVersionsTab script={loaded} /> : null}
              </TabsContent>
              <TabsContent value="script">
                <ScriptVersionView script={loaded} version={loaded.current} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </QueryView>
    </Page>
  );
}
