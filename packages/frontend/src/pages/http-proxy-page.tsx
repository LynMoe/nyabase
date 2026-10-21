import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, RefreshCw } from 'lucide-react';
import { type HttpDomainPoolPublicDto, type HttpProxyBindingDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { ApiError } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { queryKeys } from '../lib/query-keys.js';
import { toast } from '../hooks/use-toast.js';
import { emptyIfNotFound, httpProxyErrorMessage } from '../lib/http-proxy.js';
import { BindingFormDialog, BindingRow } from './http-proxy-page/binding-parts.js';

export default function HttpProxyPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<{ binding: HttpProxyBindingDto; open: boolean } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<HttpProxyBindingDto | null>(null);
  const bindingsQuery = useQuery({
    queryKey: queryKeys.httpProxy.bindings,
    queryFn: () => api.get<HttpProxyBindingDto[]>('/http-proxy/bindings'),
  });
  const poolsQuery = useQuery({
    queryKey: queryKeys.httpProxy.domainPools,
    queryFn: () => api.get<HttpDomainPoolPublicDto[]>('/http-proxy/domain-pools')
      .catch(emptyIfNotFound<HttpDomainPoolPublicDto[]>([])),
    retry: (count, queryError) => (queryError instanceof ApiError && queryError.status === 404 ? false : count < 2),
  });
  const pools = poolsQuery.data ?? [];
  const canCreate = !poolsQuery.isLoading && pools.length > 0;
  const createBlockedHint = poolsQuery.isLoading
    ? '正在加载域名…'
    : '管理员尚未配置通配域名';
  const createButton = (
    <Button
      onClick={() => setCreateOpen(true)}
      disabled={!canCreate}
      title={canCreate ? undefined : createBlockedHint}
    >
      <Plus className="h-4 w-4" />新建发布
    </Button>
  );
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/http-proxy/bindings/${id}`),
    onSuccess: () => {
      toast({ title: '发布已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.httpProxy.bindings });
    },
    onError: (error) => toast({ title: '删除失败', description: httpProxyErrorMessage(error), variant: 'destructive' }),
  });
  return (
    <Page testId="http-proxy">
      <PageHeader
        title="HTTP 发布"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void bindingsQuery.refetch(); }} aria-label="刷新 HTTP 发布">
              <RefreshCw className="h-4 w-4" />
            </Button>
            {createButton}
          </>
        }
      />
      <QueryView
        query={bindingsQuery}
        resourceName="HTTP 发布"
        loadingLabel="加载 HTTP 发布..."
        showEmpty={bindingsQuery.data?.length === 0}
        empty={
          <EmptyState
            icon={Globe}
            title={canCreate ? '暂无 HTTP 发布。' : '暂无 HTTP 发布。管理员配置通配域名后才能新建。'}
            action={createButton}
          />
        }
      >
        {(items) => (
          <SectionCard flush>
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>主机名</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>容器</TableHead>
                <TableHead>端口</TableHead>
                <TableHead>HTTPS</TableHead>
                <TableHead>域名池</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((binding) => (
                <BindingRow
                  key={binding.id}
                  binding={binding}
                  onEdit={() => setEditTarget({ binding, open: true })}
                  onDelete={() => setDeleteTarget(binding)}
                />
              ))}
            </TableBody>
          </Table>
          </SectionCard>
        )}
      </QueryView>
      <BindingFormDialog pools={pools} open={createOpen} onOpenChange={setCreateOpen} />
      {editTarget && (
        <BindingFormDialog
          binding={editTarget.binding}
          pools={pools}
          open={editTarget.open}
          onOpenChange={(open) => setEditTarget({ ...editTarget, open })}
        />
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 HTTP 发布？"
        description={`将删除主机名「${deleteTarget?.hostname}」的发布绑定。域名将不再转发到该容器端口。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => { if (deleteTarget) remove.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}
