import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { IpPoolDto, ServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { SectionCard } from '../components/layout/section-card.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page-header.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import { IpPoolEditorDialog } from './ip-pools-page/ip-pool-editor-dialog.js';

export default function IpPoolsPage() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<IpPoolDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IpPoolDto | null>(null);
  const poolsQuery = useQuery({
    queryKey: queryKeys.ipPools.admin,
    queryFn: () => api.get<IpPoolDto[]>('/admin/ip-pools'),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
  });
  const deletePool = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/ip-pools/${id}`),
    onSuccess: () => {
      toast({ title: 'IP 池已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.ipPools.admin });
    },
    onError: (error) => {
      toast({ title: '删除失败', description: errorMessage(error, '操作失败'), variant: 'destructive' });
    },
  });
  const serverNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const server of serversQuery.data ?? []) map.set(server.id, server.name);
    return map;
  }, [serversQuery.data]);

  return (
    <Page testId="ip-pools">
      <PageHeader
        title="IP 池"
        actions={
          <>
            <Button variant="outline" size="icon" onClick={() => { void poolsQuery.refetch(); }} aria-label="刷新 IP 池">
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />创建 IP 池</Button>
          </>
        }
      />
      <QueryView
        query={poolsQuery}
        resourceName="IP 池"
        loadingLabel="加载 IP 池..."
        showEmpty={poolsQuery.data?.length === 0}
        empty={
          <EmptyState
            title="暂无 IP 池。创建后可勾选服务器共享同一地址段。"
            action={<Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" />创建 IP 池</Button>}
          />
        }
      >
        {(pools) => (
          <SectionCard flush>
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>局域网</TableHead>
                <TableHead>可分配</TableHead>
                <TableHead>网关</TableHead>
                <TableHead>已分配 / 可用</TableHead>
                <TableHead>保留</TableHead>
                <TableHead>绑定服务器</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pools.map((pool) => (
                <TableRow
                  key={pool.id}
                  className="cursor-pointer"
                  onClick={() => setEditTarget(pool)}
                >
                  <TableCell className="font-medium">{pool.name}</TableCell>
                  <TableCell className="font-mono">{pool.cidr}</TableCell>
                  <TableCell className="font-mono">{pool.allocationCidr}</TableCell>
                  <TableCell className="font-mono">{pool.gateway}</TableCell>
                  <TableCell>{pool.allocatedCount} / {pool.usableCount}</TableCell>
                  <TableCell className="min-w-40 max-w-xs whitespace-normal">
                    {pool.reservedIps.length > 0 ? (
                      <TechnicalId label="保留地址" value={pool.reservedIps.join(', ')} kind="text" className="font-mono text-sm [overflow-wrap:anywhere]" />
                    ) : (
                      '无'
                    )}
                  </TableCell>
                  <TableCell className="max-w-[12rem] truncate whitespace-normal">
                    {pool.serverIds.map((id) => serverNameById.get(id) ?? id).join('、') || '未绑定'}
                  </TableCell>
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="outline" onClick={() => setEditTarget(pool)}>
                        <Pencil className="h-3.5 w-3.5" />编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost-destructive"
                        onClick={() => setDeleteTarget(pool)}
                        disabled={deletePool.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />删除
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </SectionCard>
        )}
      </QueryView>
      <IpPoolEditorDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        servers={serversQuery.data ?? []}
        mode="create"
      />
      <IpPoolEditorDialog
        open={Boolean(editTarget)}
        onOpenChange={(open) => { if (!open) setEditTarget(null); }}
        servers={serversQuery.data ?? []}
        mode="edit"
        pool={editTarget}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 IP 池？"
        description={`将删除「${deleteTarget?.name}」（${deleteTarget?.cidr}）。仍有地址占用时会拒绝删除。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deletePool.isPending}
        testId="ip-pool-delete-confirm"
        onConfirm={() => { if (deleteTarget) deletePool.mutate(deleteTarget.id); }}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      />
    </Page>
  );
}
