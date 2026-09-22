import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Gauge, HardDrive, Pencil, RefreshCw, Server, Trash2 } from 'lucide-react';
import {
  Capability,
  FailureCode,
  zPatchSharedBackendRequest,
  type SharedBackendDto,
  type SharedBackendExecutorDiscoverResult,
  type SharedBackendExecutorDto,
  type SharedVolumeDto,
} from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog.js';
import { Input } from '../components/ui/input.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { FormField } from '../components/layout/form-field.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { FsidConflictAlert } from '../components/storage/fsid-conflict-alert.js';
import { SharedVolumeCatalogInspectDialog } from '../components/storage/shared-volume-catalog-inspect.js';
import { SharedVolumeTable } from '../components/storage/shared-volume-table.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { approxGibHint, formatPercent, relativeTime, sharedBackendAvailableBytes } from '../lib/utils.js';
import { toast } from '../hooks/use-toast.js';
import { volumeInProgress } from '../lib/in-progress.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { failureCodeLabel } from '../lib/status-labels.js';
import {
  identityConflictFromDiscoverIssue,
  parseSharedBackendFsidConflict,
  type SharedBackendFsidConflict,
} from '../lib/storage-shrink.js';
import { useAuthStore } from '../store/auth.js';
import {
  type SharedBackendDetailTab,
} from '../lib/shared-backend-detail.js';

const routeApi = getRouteApi('/shared-backends/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['executors', '执行端', Server],
  ['volumes', '租户卷', HardDrive],
] as const;

function bytesLabel(bytes: number | null): string {
  return bytes === null ? '未知' : approxGibHint(bytes).replace(/^约 /, '');
}

export default function SharedBackendDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/shared-backends/$id' });
  const queryClient = useQueryClient();
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageSharedBackends = capabilities.includes(Capability.ManageSharedBackends);
  const canManageSharedVolumes = capabilities.includes(Capability.ManageSharedVolumes);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inspectTarget, setInspectTarget] = useState<SharedVolumeDto | null>(null);
  const [pageConflict, setPageConflict] = useState<SharedBackendFsidConflict | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [overcommitRatio, setOvercommitRatio] = useState('');

  const selectTab = (next: SharedBackendDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const backendQuery = useQuery({
    queryKey: queryKeys.sharedBackends.detail(id),
    queryFn: () => api.get<SharedBackendDto>(`/admin/shared-backends/${id}`),
  });
  const volumesQuery = useQuery({
    queryKey: queryKeys.sharedVolumes.admin,
    queryFn: () => api.get<SharedVolumeDto[]>('/admin/shared-volumes'),
    enabled: tab === 'volumes' && canManageSharedVolumes,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: 5_000,
      isSettled: (volumes) => volumes.every((volume) => !volumeInProgress(volume)),
    }),
  });

  useEffect(() => {
    const backend = backendQuery.data;
    if (!backend) return;
    setDisplayName(backend.displayName ?? '');
    setOvercommitRatio(String(backend.overcommitRatio));
  }, [backendQuery.data]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
  };

  const patchBackend = useMutation({
    mutationFn: (body: { expectedRevision: number; displayName?: string | null; overcommitRatio?: number }) =>
      api.patch<SharedBackendDto>(`/admin/shared-backends/${id}`, body),
    onSuccess: () => {
      toast({ title: '共享后端已更新' });
      setIdentityOpen(false);
      invalidate();
    },
    onError: (error) => {
      const conflict = parseSharedBackendFsidConflict(error);
      if (conflict) setPageConflict(conflict);
      toast({ title: '更新失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const patchExecutor = useMutation({
    mutationFn: ({
      executor,
      registered,
    }: {
      executor: SharedBackendExecutorDto;
      registered: boolean;
    }) =>
      api.patch<SharedBackendExecutorDto>(
        `/admin/shared-backends/${id}/executors/${executor.id}`,
        { expectedRevision: executor.revision, registered },
      ),
    onSuccess: (_data, variables) => {
      toast({ title: variables.registered ? '执行端已登记' : '已取消执行端登记' });
      invalidate();
    },
    onError: (error) => toast({ title: '执行端登记失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const discoverExecutors = useMutation({
    mutationFn: () =>
      api.post<SharedBackendExecutorDiscoverResult>(
        `/admin/shared-backends/${id}/executors/discover`,
        {},
      ),
    onSuccess: (result) => {
      for (const issue of result.identityConflicts) {
        const conflict = identityConflictFromDiscoverIssue(issue);
        if (conflict) {
          setPageConflict(conflict);
          continue;
        }
        if (
          issue.code === FailureCode.StoragePoolInUse
          || issue.code === FailureCode.ServerUnreachable
        ) {
          toast({
            title: failureCodeLabel(issue.code) ?? issue.code,
            description: issue.message,
            variant: 'destructive',
          });
        }
      }
      if (result.identityConflicts.length === 0) {
        toast({ title: '执行端发现已完成', description: `发现 ${result.executors.length} 个执行端。` });
      }
      invalidate();
    },
    onError: (error) => {
      const conflict = parseSharedBackendFsidConflict(error);
      if (conflict) setPageConflict(conflict);
      toast({ title: '发现执行端失败', description: errorMessage(error), variant: 'destructive' });
    },
  });
  const deleteBackend = useMutation({
    mutationFn: () => api.delete<void>(`/admin/shared-backends/${id}`),
    onSuccess: () => {
      toast({ title: '共享后端已删除' });
      setDeleteOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedBackends.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sharedVolumes.admin });
      void navigate({ to: '/shared-backends' });
    },
    onError: (error) => {
      const conflict = parseSharedBackendFsidConflict(error);
      if (conflict) setPageConflict(conflict);
      toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' });
    },
  });

  const saveOverview = () => {
    const backend = backendQuery.data;
    if (!backend) return;
    const parsed = zPatchSharedBackendRequest.safeParse({
      expectedRevision: backend.revision,
      displayName: displayName.trim() || null,
      overcommitRatio: Number(overcommitRatio),
    });
    if (!parsed.success) {
      toast({
        title: '请检查参数',
        description: parsed.error.issues[0]?.message ?? '显示名称或超分比例无效',
        variant: 'destructive',
      });
      return;
    }
    patchBackend.mutate(parsed.data);
  };

  const backend = backendQuery.data;
  const title = backend?.displayName ?? backend?.name ?? '共享存储';

  return (
    <Page testId="shared-backend-detail">
      <PageHeader
        title={title}
        crumbs={[
          { label: '共享存储', to: '/shared-backends' },
          { label: title === '共享存储' ? '…' : title },
        ]}
        actions={
          backend && canManageSharedBackends ? (
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="h-4 w-4" />删除后端
            </Button>
          ) : undefined
        }
      />
      {pageConflict && (
        <FsidConflictAlert conflict={pageConflict} onDismiss={() => setPageConflict(null)} />
      )}
      <QueryView
        query={backendQuery}
        resourceName="共享后端"
        loadingLabel="加载共享后端..."
        onBack={() => window.history.back()}
      >
        {(loaded) => {
          const available = sharedBackendAvailableBytes(loaded);
          const executors = loaded.executors ?? [];
          const volumes = (volumesQuery.data ?? []).filter((volume) => volume.sharedBackendId === loaded.id);
          return (
            <Tabs
              value={tab}
              onValueChange={(value) => selectTab(value as SharedBackendDetailTab)}
              data-testid="shared-backend-detail-tabs"
            >
              <TabsList>
                {TAB_ITEMS.map(([key, label, Icon]) => (
                  <TabsTrigger key={key} value={key} className="gap-1.5" data-testid={`shared-backend-tab-${key}`}>
                    <Icon className="h-4 w-4" />{label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="overview" className="space-y-6">
                <SectionCard
                  title="身份"
                  actions={canManageSharedBackends ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDisplayName(loaded.displayName ?? '');
                        setOvercommitRatio(String(loaded.overcommitRatio));
                        setIdentityOpen(true);
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />编辑
                    </Button>
                  ) : undefined}
                >
                  <div className="grid gap-3 text-sm sm:grid-cols-2">
                    <IdentityRow label="名称" value={loaded.name} />
                    <IdentityRow label="显示名称" value={loaded.displayName ?? '—'} />
                    <IdentityRow label="identity key" value={<TechnicalId label="identity key" value={loaded.identityKey} />} />
                    <IdentityRow label="Ceph FSID" value={<TechnicalId label="Ceph FSID" value={loaded.cephFsid} />} />
                    <IdentityRow label="超分比例" value={formatPercent(loaded.overcommitRatio)} />
                    <IdentityRow label="最近更新" value={relativeTime(loaded.updatedAt)} />
                  </div>
                </SectionCard>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">容量</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    <IdentityRow label="容量" value={bytesLabel(loaded.totalBytes)} />
                    <IdentityRow label="已用" value={bytesLabel(loaded.usedBytes)} />
                    <IdentityRow label="可用" value={bytesLabel(available)} />
                    <IdentityRow label="在线执行端" value={loaded.hasOnlineExecutor ? '有' : '无'} />
                    <IdentityRow label="服务器" value={`${loaded.serverIds.length} 台`} />
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="executors" className="space-y-6">
                <SectionCard
                  title="执行端"
                  actions={
                    canManageSharedBackends ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => discoverExecutors.mutate()}
                        disabled={discoverExecutors.isPending || patchExecutor.isPending}
                      >
                        <RefreshCw className={discoverExecutors.isPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                        发现执行端
                      </Button>
                    ) : undefined
                  }
                  flush={executors.length > 0}
                >
                  <div data-testid="shared-backend-executors">
                    {executors.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        尚未发现执行端。先登记后端，再对在线服务器发现执行端。
                      </p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>服务器</TableHead>
                            <TableHead>Incus 名</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>容量</TableHead>
                            <TableHead>已用</TableHead>
                            {canManageSharedBackends ? <TableHead className="text-right">操作</TableHead> : null}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {executors.map((executor) => (
                            <TableRow key={executor.id}>
                              <TableCell>{executor.serverName}</TableCell>
                              <TableCell className="font-mono">{executor.incusName}</TableCell>
                              <TableCell>{executor.registered ? '已登记' : '未登记'}</TableCell>
                              <TableCell>{bytesLabel(executor.totalBytes)}</TableCell>
                              <TableCell>{bytesLabel(executor.usedBytes)}</TableCell>
                              {canManageSharedBackends ? (
                                <TableCell className="text-right">
                                  <Button
                                    size="sm"
                                    variant={executor.registered ? 'outline' : 'default'}
                                    disabled={discoverExecutors.isPending || patchExecutor.isPending}
                                    onClick={() => patchExecutor.mutate({
                                      executor,
                                      registered: !executor.registered,
                                    })}
                                  >
                                    {executor.registered ? '取消登记' : '登记'}
                                  </Button>
                                </TableCell>
                              ) : null}
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </SectionCard>
              </TabsContent>
              <TabsContent value="volumes">
                {!canManageSharedVolumes ? (
                  <p className="text-sm text-muted-foreground">
                    查看租户共享卷需要「管理共享卷」权限。
                  </p>
                ) : volumesQuery.data === undefined && volumesQuery.isError ? (
                  <p className="text-sm text-destructive">无法加载租户共享卷。</p>
                ) : volumesQuery.data === undefined ? (
                  <p className="text-sm text-muted-foreground">加载租户共享卷...</p>
                ) : (
                  <SectionCard title="租户共享卷" flush testId="shared-backend-tenant-volumes">
                    <SharedVolumeTable
                      volumes={volumes}
                      plane="admin"
                      onInspect={setInspectTarget}
                    />
                  </SectionCard>
                )}
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
      {identityOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) setIdentityOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑共享后端</DialogTitle>
            </DialogHeader>
            <FormField id="shared-backend-display-name" label="显示名称">
              <Input
                id="shared-backend-display-name"
                value={displayName}
                placeholder={backend?.name}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </FormField>
            <FormField id="shared-backend-overcommit" label="超分比例">
              <Input
                id="shared-backend-overcommit"
                value={overcommitRatio}
                onChange={(event) => setOvercommitRatio(event.target.value)}
              />
            </FormField>
            <DialogFooter>
              <Button variant="outline" onClick={() => setIdentityOpen(false)} disabled={patchBackend.isPending}>取消</Button>
              <Button onClick={saveOverview} disabled={patchBackend.isPending}>
                {patchBackend.isPending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <SharedVolumeCatalogInspectDialog
        volume={inspectTarget}
        open={Boolean(inspectTarget)}
        onOpenChange={(open) => { if (!open) setInspectTarget(null); }}
      />
      <ConfirmDialog
        open={deleteOpen}
        title="删除共享后端？"
        description={
          <>
            将删除登记「{backend?.displayName ?? backend?.name}」。仍有关联存储池或数据卷时后端可能拒绝删除。
            {backend && (
              <dl className="mt-3 space-y-2 rounded-md border px-3 py-3 text-sm text-foreground">
                <div>
                  <dt className="text-xs text-muted-foreground">显示名称</dt>
                  <dd>{backend.displayName ?? backend.name}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">identity key</dt>
                  <dd className="break-all font-mono text-xs">{backend.identityKey}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Ceph FSID</dt>
                  <dd className="break-all font-mono text-xs">{backend.cephFsid}</dd>
                </div>
              </dl>
            )}
          </>
        }
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deleteBackend.isPending}
        testId="shared-backend-delete-confirm"
        onConfirm={() => deleteBackend.mutate()}
        onOpenChange={(open) => { if (!open) setDeleteOpen(false); }}
      />
    </Page>
  );
}

function IdentityRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {typeof value === 'string' ? <p className="break-all">{value}</p> : value}
    </div>
  );
}
