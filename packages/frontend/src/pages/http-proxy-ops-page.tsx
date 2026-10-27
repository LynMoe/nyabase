import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import type { HttpDomainPoolDto, HttpProxyBindingDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import { queryPollInterval } from '../lib/query-lifecycle.js';
import { ACCESS } from '../lib/route-access.js';
import { useHasRole } from '../lib/use-role.js';
import { emptyIfNotFound, httpProxyErrorMessage } from '../lib/http-proxy.js';
import { HTTP_PROXY_BINDINGS_POLL_MS } from '../components/http-proxy/binding-traffic.js';
import {
  AllBindingsCard,
  DomainPoolFormDialog,
  DomainPoolsCard,
} from './http-proxy-ops-page/domain-pools-section.js';
import {
  emptyStatus,
  formatTime,
  type HttpProxyAdminStatus,
  HttpStatusSections,
} from './http-proxy-ops-page/status-sections.js';

export default function HttpProxyOpsPage() {
  const qc = useQueryClient();
  const canViewStatus = useHasRole(ACCESS.httpProxyOps);
  const canManagePools = canViewStatus;
  const [poolForm, setPoolForm] = useState<HttpDomainPoolDto | 'create' | null>(null);
  const [deletePool, setDeletePool] = useState<HttpDomainPoolDto | null>(null);
  const [deleteBinding, setDeleteBinding] = useState<HttpProxyBindingDto | null>(null);

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
    refetchInterval: (query) => queryPollInterval(query.state, {
      activeIntervalMs: HTTP_PROXY_BINDINGS_POLL_MS,
      // A Backend without the endpoint (404 → null) is not polled.
      isTerminal: (data) => data === null,
    }),
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
  const removeBinding = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/http-proxy/bindings/${id}?scope=all`),
    onSuccess: () => {
      toast({ title: '发布绑定已删除' });
      setDeleteBinding(null);
      void qc.invalidateQueries({ queryKey: queryKeys.httpProxy.adminBindings });
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
              {Array.isArray(allBindings) ? <AllBindingsCard bindings={allBindings} onDelete={setDeleteBinding} /> : null}
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
        description={`将删除通配域名「${deletePool?.wildcardDomain}」。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={removePool.isPending}
        onConfirm={() => { if (deletePool) removePool.mutate(deletePool.id); }}
      />
      <ConfirmDialog
        open={Boolean(deleteBinding)}
        onOpenChange={(open) => { if (!open) setDeleteBinding(null); }}
        title="删除发布绑定？"
        description={`将删除用户「${deleteBinding?.ownerUsername}」的发布「${deleteBinding?.hostname}」。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={removeBinding.isPending}
        onConfirm={() => { if (deleteBinding) removeBinding.mutate(deleteBinding.id); }}
      />
    </Page>
  );
}
