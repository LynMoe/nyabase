import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, RefreshCw } from 'lucide-react';
import type { ServerDto, StoragePoolDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { EmptyState } from '../components/layout/empty-state.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { usedTotalLabel } from '../lib/utils.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';

export default function StoragePoolsPage() {
  const queryClient = useQueryClient();
  const [pageConflict, setPageConflict] = useState<SharedBackendFsidConflict | null>(null);
  const [unregisterTarget, setUnregisterTarget] = useState<StoragePoolDto | null>(null);
  const serversQuery = useQuery({ queryKey: queryKeys.servers.admin, queryFn: () => api.get<ServerDto[]>('/admin/servers') });
  const poolsQuery = useQuery({
    queryKey: queryKeys.storagePools.adminIndex,
    queryFn: async () => {
      const servers = await queryClient.ensureQueryData({
        queryKey: queryKeys.servers.admin,
        queryFn: () => api.get<ServerDto[]>('/admin/servers'),
      });
      const rows = await Promise.all(servers.map(async (server) => (await api.get<StoragePoolDto[]>(`/admin/servers/${server.id}/storage-pools`)).map((pool) => ({ pool, server }))));
      return rows.flat();
    },
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.storagePools.adminIndex });
    void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
  };
  const discover = useMutation({
    mutationFn: (serverId: string) => api.post<StoragePoolDto[]>(`/admin/servers/${serverId}/storage-pools/discover`),
    onSuccess: () => { toast({ title: '存储池发现已完成' }); refresh(); },
    onError: (error) => {
      const conflict = parseSharedBackendFsidConflict(error);
      if (conflict) {
        setPageConflict(conflict);
        toast({
          title: 'FSID 冲突',
          description: `${conflict.identityKey ?? 'identity'}：已登记 ${conflict.expectedFsid ?? '?'} vs ${conflict.conflictingFsid ?? '?'}`,
          variant: 'destructive',
        });
        return;
      }
      toast({ title: '发现失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const patch = useMutation({
    mutationFn: ({ pool, registered }: { pool: StoragePoolDto; registered: boolean }) => api.patch<StoragePoolDto>(`/admin/storage-pools/${pool.id}`, { expectedRevision: pool.revision, registered, displayName: pool.displayName, sharedBackendId: pool.sharedBackendId }),
    onSuccess: (_data, variables) => {
      toast({ title: variables.registered ? '存储池已登记' : '已取消登记' });
      setUnregisterTarget(null);
      refresh();
    },
    onError: (error) => toast({ title: '登记失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const rows = poolsQuery.data ?? [];
  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ pool: StoragePoolDto; server: ServerDto }>>();
    for (const row of rows) map.set(row.server.id, [...(map.get(row.server.id) ?? []), row]);
    return [...map.values()];
  }, [rows]);
  return (
    <Page testId="storage-pools">
      <PageHeader
        title="存储池"
        description="查看各服务器上的存储池容量，并登记后供新建本地数据卷选用。不列出逻辑共享卷；共享卷请到「共享卷管理」。缩容是否需停止或卸载由池能力决定。"
        actions={<Button variant="outline" onClick={refresh}><RefreshCw className="h-4 w-4" />刷新</Button>}
      />
      {pageConflict && (
        <FsidConflictAlert conflict={pageConflict} onDismiss={() => setPageConflict(null)} />
      )}
      <QueryView
        queries={[serversQuery, poolsQuery]}
        resourceNames={['服务器', '存储池']}
        loadingLabel="加载存储池..."
      >
        {() => grouped.length === 0 ? (
          <EmptyState title="暂无服务器或存储池。" />
        ) : (
          grouped.map((serverPools) => (
            <Card key={serverPools[0]!.server.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <HardDrive className="h-4 w-4" />
                    {serverPools[0]!.server.name}
                  </CardTitle>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => discover.mutate(serverPools[0]!.server.id)}
                    disabled={discover.isPending}
                  >
                    <RefreshCw className={discover.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                    发现
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-md border">
                  <Table className="min-w-[800px]">
                    <TableHeader>
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableHead>池</TableHead>
                        <TableHead>容量</TableHead>
                        <TableHead>能力</TableHead>
                        <TableHead>共享后端</TableHead>
                        <TableHead>状态</TableHead>
                        <TableHead>操作</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {serverPools.map(({ pool }) => (
                        <PoolRow
                          key={pool.id}
                          pool={pool}
                          onRegister={() => {
                            if (pool.registered) {
                              setUnregisterTarget(pool);
                              return;
                            }
                            patch.mutate({ pool, registered: true });
                          }}
                          busy={patch.isPending}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </QueryView>
      <ConfirmDialog
        open={Boolean(unregisterTarget)}
        onOpenChange={(open) => { if (!open) setUnregisterTarget(null); }}
        title="取消登记存储池？"
        description={`取消后，「${unregisterTarget?.displayName ?? unregisterTarget?.incusName}」将从可建卷集合中移除；已有数据卷不受影响，但新建卷时将无法再选择该池。`}
        confirmLabel="确认取消登记"
        pendingLabel="处理中..."
        pending={patch.isPending}
        testId="storage-pool-unregister-confirm"
        onConfirm={() => {
          if (unregisterTarget) patch.mutate({ pool: unregisterTarget, registered: false });
        }}
      />
    </Page>
  );
}

function PoolRow({ pool, onRegister, busy }: { pool: StoragePoolDto; onRegister: () => void; busy: boolean }) {
  const capacity = usedTotalLabel(pool.usedBytes, pool.totalBytes);
  const shrinkBadge = pool.capability.shrinkOnline
    ? '在线缩容'
    : pool.capability.shrinkNever
      ? '不可缩容'
      : pool.capability.shrinkRequiresStop
        ? '缩容需停止/卸载'
        : '缩容需停止/卸载';
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{pool.displayName ?? pool.incusName}</div>
        <div className="font-mono text-xs text-muted-foreground">{pool.driver} · {pool.resizeFamily}</div>
      </TableCell>
      <TableCell>
        {capacity}
        <div className="text-xs text-muted-foreground">
          {pool.quotaEffective === null ? '配额未知' : pool.quotaEffective ? '配额有效' : '配额无效'}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          <Badge variant={pool.capability.growOnline ? 'success' : 'secondary'}>在线扩容</Badge>
          <Badge variant={pool.capability.shrinkOnline ? 'success' : pool.capability.shrinkNever ? 'destructive' : 'warning'}>
            {shrinkBadge}
          </Badge>
          {pool.rootDiskCapable && <Badge variant="outline">系统盘</Badge>}
          {pool.shareable && <Badge variant="outline">共享</Badge>}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs">{pool.sharedBackendId ?? '—'}</TableCell>
      <TableCell>{pool.registered ? '已登记' : '未登记'}</TableCell>
      <TableCell>
        <Button size="sm" variant={pool.registered ? 'outline' : 'default'} onClick={onRegister} disabled={busy}>
          {pool.registered ? '取消登记' : '登记'}
        </Button>
      </TableCell>
    </TableRow>
  );
}


