import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { HttpDomainPoolDto, HttpProxyBindingDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { toast } from '../hooks/use-toast.js';
import { useAuthStore } from '../store/auth.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import {
  canManageHttpProxyPools,
  canViewHttpProxyStatus,
} from '../lib/proxy-access.js';
import { emptyIfNotFound, httpProxyErrorMessage } from '../lib/http-proxy.js';
import { DomainPoolFormDialog } from './http-proxy-ops-page/domain-pools-section.js';
import { AllBindingsCard, DomainPoolsCard } from './http-proxy-ops-page/domain-pools-section.js';
import {
  HttpStatusSections,
  emptyStatus,
  formatTime,
  type HttpProxyAdminStatus,
} from './http-proxy-ops-page/status-sections.js';

export default function HttpProxyOpsPage() {
  const qc = useQueryClient();
  const user = useAuthStore((state) => state.user);
  const canViewStatus = canViewHttpProxyStatus(user?.capabilities ?? []);
  const canManagePools = canManageHttpProxyPools(user?.capabilities ?? []);
  const [poolForm, setPoolForm] = useState<HttpDomainPoolDto | 'create' | null>(null);
  const [deletePool, setDeletePool] = useState<HttpDomainPoolDto | null>(null);

  const statusQuery = useQuery({
    queryKey: queryKeys.httpProxy.adminStatus,
    queryFn: () => api.get<HttpProxyAdminStatus>('/http-proxy/status'),
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: 1_000,
      transientBaseIntervalMs: 2_000,
      transientMaxIntervalMs: 30_000,
    }),
    enabled: canViewStatus,
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.httpProxy.adminDomainPools,
    queryFn: () => api.get<HttpDomainPoolDto[]>('/http-proxy/domain-pools?scope=all'),
    enabled: canManagePools,
  });
  const bindingsQuery = useQuery({
    queryKey: queryKeys.httpProxy.adminBindings,
    queryFn: () => api.get<HttpProxyBindingDto[]>('/http-proxy/bindings?scope=all')
      .catch(emptyIfNotFound<HttpProxyBindingDto[] | null>(null)),
    enabled: canManagePools,
    retry: (count, error) => (error instanceof ApiError && error.status === 404 ? false : count < 2),
  });

  const removePool = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/http-proxy/domain-pools/${id}`),
    onSuccess: () => {
      toast({ title: '域名池已删除' });
      setDeletePool(null);
      void qc.invalidateQueries({ queryKey: queryKeys.httpProxy.adminDomainPools });
    },
    onError: (error) => toast({ title: '删除失败', description: httpProxyErrorMessage(error), variant: 'destructive' }),
  });
  const status = statusQuery.data ?? emptyStatus;
  const pools = poolsQuery.data ?? [];
  const allBindings = bindingsQuery.data;
  const statusDescription = !canViewStatus
    ? undefined
    : statusQuery.isError
      ? '代理状态加载失败'
      : status.updatedAt ? `最后更新 ${formatTime(status.updatedAt)}` : '等待代理上报实时状态';

  return (
    <Page testId="http-proxy-ops">
      <PageHeader
        title="HTTP 代理"
        description={statusDescription}
        actions={canViewStatus ? (
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => { void statusQuery.refetch(); }} disabled={statusQuery.isFetching}>
            <RefreshCw className={`h-4 w-4 ${statusQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        ) : undefined}
      />

      {canViewStatus && (
        <QueryView query={statusQuery} resourceName="HTTP 代理状态" loadingLabel="加载 HTTP 代理状态...">
          {(loaded) => <HttpStatusSections status={loaded} />}
        </QueryView>
      )}

      {canManagePools && (
        <QueryView
          queries={[poolsQuery, bindingsQuery]}
          resourceNames={['域名池', 'HTTP 发布绑定']}
          loadingLabel="加载域名池..."
        >
          {() => (
            <div className="space-y-6">
              <DomainPoolsCard
                pools={pools}
                refreshing={poolsQuery.isFetching}
                onRefresh={() => { void poolsQuery.refetch(); }}
                onCreate={() => setPoolForm('create')}
                onEdit={setPoolForm}
                onDelete={setDeletePool}
              />
              {Array.isArray(allBindings) ? <AllBindingsCard bindings={allBindings} /> : null}
            </div>
          )}
        </QueryView>
      )}

      {poolForm && (
        <DomainPoolFormDialog
          pool={poolForm === 'create' ? undefined : poolForm}
          open
          onOpenChange={(open) => { if (!open) setPoolForm(null); }}
        />
      )}
      <ConfirmDialog
        open={Boolean(deletePool)}
        onOpenChange={(open) => { if (!open) setDeletePool(null); }}
        title="删除域名池？"
        description={`将删除通配域名「${deletePool?.wildcardDomain}」。若仍有 HTTP 发布使用该池，删除会被拒绝。请先停用该池，或让用户删除相关发布。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={removePool.isPending}
        onConfirm={() => { if (deletePool) removePool.mutate(deletePool.id); }}
      />
    </Page>
  );
}
