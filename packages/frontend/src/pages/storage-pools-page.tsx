import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, RefreshCw } from 'lucide-react';
import type { ServerDto, StoragePoolDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { QueryErrorState, QueryLoadingState } from '../components/query-state.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { usedTotalLabel } from '../lib/utils.js';
import { toast } from '../hooks/use-toast.js';
import {
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';

export default function StoragePoolsPage() {
  const queryClient = useQueryClient();
  const [pageConflict, setPageConflict] = useState<SharedBackendFsidConflict | null>(null);
  const [unregisterTarget, setUnregisterTarget] = useState<StoragePoolDto | null>(null);
  const serversQuery = useQuery({ queryKey: ['storage-pools', 'servers'], queryFn: () => api.get<ServerDto[]>('/admin/servers') });
  const poolsQuery = useQuery({
    queryKey: ['storage-pools', 'admin'],
    queryFn: async () => {
      const servers = serversQuery.data ?? [];
      const rows = await Promise.all(servers.map(async (server) => (await api.get<StoragePoolDto[]>(`/admin/servers/${server.id}/storage-pools`)).map((pool) => ({ pool, server }))));
      return rows.flat();
    },
    enabled: serversQuery.isSuccess,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['storage-pools'] });
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

  if (serversQuery.isLoading || poolsQuery.isLoading) return <QueryLoadingState label="加载存储池..." />;
  if (serversQuery.isError) return <QueryErrorState error={serversQuery.error} resourceName="服务器" onRetry={() => { void serversQuery.refetch(); }} />;
  if (poolsQuery.isError) return <QueryErrorState error={poolsQuery.error} resourceName="存储池" onRetry={() => { void poolsQuery.refetch(); }} />;

  return (
    <div className="space-y-5 px-4 py-4 md:px-6" data-testid="storage-pools">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">存储池</h1>
          <p className="text-sm text-muted-foreground">
            查看各服务器上的存储池容量，并登记后供新建数据卷选用。缩容是否需停止或卸载由池能力决定。
          </p>
        </div>
        <Button variant="outline" onClick={refresh}><RefreshCw className="h-4 w-4" />刷新</Button>
      </div>
      {pageConflict && (
        <FsidConflictAlert conflict={pageConflict} onDismiss={() => setPageConflict(null)} />
      )}
      {grouped.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">暂无服务器或存储池。</CardContent></Card>
      ) : grouped.map((serverPools) => (
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
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full min-w-[800px] text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">池</th>
                    <th className="px-3 py-2">容量</th>
                    <th className="px-3 py-2">能力</th>
                    <th className="px-3 py-2">共享后端</th>
                    <th className="px-3 py-2">状态</th>
                    <th className="px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody>
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
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}
      <Dialog open={Boolean(unregisterTarget)} onOpenChange={(open) => { if (!open) setUnregisterTarget(null); }}>
        <DialogContent data-testid="storage-pool-unregister-confirm">
          <DialogHeader>
            <DialogTitle>取消登记存储池？</DialogTitle>
            <DialogDescription>
              取消后，「{unregisterTarget?.displayName ?? unregisterTarget?.incusName}」将从可建卷集合中移除；已有数据卷不受影响，但新建卷时将无法再选择该池。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnregisterTarget(null)} disabled={patch.isPending}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (unregisterTarget) patch.mutate({ pool: unregisterTarget, registered: false });
              }}
              disabled={patch.isPending}
            >
              {patch.isPending ? '处理中...' : '确认取消登记'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="font-medium">{pool.displayName ?? pool.incusName}</div>
        <div className="font-mono text-xs text-muted-foreground">{pool.driver} · {pool.resizeFamily}</div>
      </td>
      <td className="px-3 py-2">
        {capacity}
        <div className="text-xs text-muted-foreground">
          {pool.quotaEffective === null ? '配额未知' : pool.quotaEffective ? '配额有效' : '配额无效'}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          <Badge variant={pool.capability.growOnline ? 'success' : 'secondary'}>在线扩容</Badge>
          <Badge variant={pool.capability.shrinkOnline ? 'success' : pool.capability.shrinkNever ? 'destructive' : 'warning'}>
            {shrinkBadge}
          </Badge>
          {pool.rootDiskCapable && <Badge variant="outline">系统盘</Badge>}
          {pool.shareable && <Badge variant="outline">共享</Badge>}
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-xs">{pool.sharedBackendId ?? '—'}</td>
      <td className="px-3 py-2">{pool.registered ? '已登记' : '未登记'}</td>
      <td className="px-3 py-2">
        <Button size="sm" variant={pool.registered ? 'outline' : 'default'} onClick={onRegister} disabled={busy}>
          {pool.registered ? '取消登记' : '登记'}
        </Button>
      </td>
    </tr>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请稍后重试';
}
