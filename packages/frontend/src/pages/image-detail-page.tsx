import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { CircleAlert, Gauge, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { AdminImageDto, ImageAssignmentDto, IntentAcceptedDto, ServerDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/api-error.js';
import { Button } from '../components/ui/button.js';
import { StatusBadge } from '../components/layout/status-badge.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table.js';
import { ConfirmDialog } from '../components/layout/confirm-dialog.js';
import { Page } from '../components/layout/page.js';
import { PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { SectionCard } from '../components/layout/section-card.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js';
import { ResourceIntentFailures, ResourceIntentHistory } from '../components/intents/resource-intent-failures.js';
import { formatBytes, relativeTime } from '../lib/utils.js';
import { assignmentInProgress, imageInProgress } from '../lib/in-progress.js';
import { lifecyclePhaseLabel } from '../lib/display-labels.js';
import { toast } from '../hooks/use-toast.js';
import { queryKeys } from '../lib/query-keys.js';
import { refetchWhileInProgress } from '../lib/query-lifecycle.js';
import { type ImageDetailTab } from '../lib/image-detail.js';

const routeApi = getRouteApi('/images/$id');

const TAB_ITEMS = [
  ['overview', '概览', Gauge],
  ['assignments', '分配', Server],
] as const;

type AssignmentResponse = {
  assignment: ImageAssignmentDto;
  intent?: IntentAcceptedDto;
};

export default function ImageDetailPage() {
  const { id } = routeApi.useParams();
  const { tab } = routeApi.useSearch();
  const navigate = useNavigate({ from: '/images/$id' });
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const selectTab = (next: ImageDetailTab) => {
    void navigate({ search: (prev) => ({ ...prev, tab: next }) });
  };

  const imageQuery = useQuery({
    queryKey: queryKeys.images.detail(id),
    queryFn: () => api.get<AdminImageDto>(`/admin/images/${id}`),
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (image) => !imageInProgress(image)
        && image.assignments.every((assignment) => !assignmentInProgress(assignment)),
    }),
  });
  const serversQuery = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/admin/servers'),
    enabled: tab === 'assignments',
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.resourceIntentFailures('admin', `/admin/images/${id}/intents`, 20),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.resourceIntentFailures('admin', `/admin/images/${id}/intents`, 50),
    });
  };

  const assign = useMutation({
    mutationFn: ({ serverId, expectedGeneration }: { serverId: string; expectedGeneration?: number }) =>
      api.put<AssignmentResponse>(`/admin/images/${id}/assignments/${serverId}`, expectedGeneration ? { expectedGeneration } : {}),
    onSuccess: (result) => {
      toast({ title: '镜像分配意图已创建', description: result.intent ? `意图 ${result.intent.intentId.slice(0, 8)}` : undefined });
      invalidate();
    },
    onError: (error) => toast({ title: '镜像分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const unassign = useMutation({
    mutationFn: ({ serverId, generation }: { serverId: string; generation: number }) =>
      api.delete<AssignmentResponse>(`/admin/images/${id}/assignments/${serverId}?expectedGeneration=${generation}`),
    onSuccess: () => {
      toast({ title: '镜像取消分配意图已创建' });
      invalidate();
    },
    onError: (error) => toast({ title: '取消分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const repullImage = useMutation({
    mutationFn: () => api.post<unknown>(`/admin/images/${id}/repull`),
    onSuccess: () => {
      toast({ title: '已从镜像源重新拉取' });
      invalidate();
    },
    onError: (error) => toast({ title: '重新拉取失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const deleteImage = useMutation({
    mutationFn: () => api.delete<unknown>(`/admin/images/${id}`),
    onSuccess: () => {
      toast({ title: '镜像移除意图已提交' });
      setDeleteOpen(false);
      invalidate();
      void navigate({ to: '/images' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });

  const image = imageQuery.data;
  const servers = serversQuery.data ?? [];

  return (
    <Page testId="image-detail">
      <PageHeader
        title={image?.alias ?? '镜像'}
        crumbs={[
          { label: '镜像', to: '/images' },
          { label: image?.alias ?? '…' },
        ]}
        actions={
          image && !image.deleting ? (
            <>
              <Button variant="outline" onClick={() => repullImage.mutate()} disabled={repullImage.isPending}>
                <RefreshCw className="h-4 w-4" />重新拉取
              </Button>
              <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="h-4 w-4" />移除
              </Button>
            </>
          ) : undefined
        }
      />
      <QueryView
        query={imageQuery}
        resourceName="镜像"
        loadingLabel="加载镜像..."
        onBack={() => window.history.back()}
      >
        {(loaded) => {
          const assignments = loaded.assignments ?? [];
          return (
            <Tabs
              value={tab}
              onValueChange={(value) => selectTab(value as ImageDetailTab)}
              data-testid="image-detail-tabs"
            >
              <TabsList>
                {TAB_ITEMS.map(([key, label, Icon]) => (
                  <TabsTrigger key={key} value={key} className="gap-1.5">
                    <Icon className="h-4 w-4" />{label}
                  </TabsTrigger>
                ))}
              </TabsList>
              <TabsContent value="overview" className="space-y-6">
                <Card>
                  <CardHeader className="flex flex-row items-start justify-between space-y-0">
                    <CardTitle className="text-base">身份</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                    <Info
                      label="别名"
                      value={loaded.alias.length > 64
                        ? <TechnicalId label="别名" value={loaded.alias} kind="opaque" />
                        : <span className="font-mono text-xs">{loaded.alias}</span>}
                    />
                    <Info label="登录用户" value={loaded.loginUser} mono />
                    <Info label="最小系统盘" value={loaded.minRootSizeBytes === null ? '未设置' : formatBytes(loaded.minRootSizeBytes)} />
                    <Info label="网络由平台管理" value={loaded.networkManagedExternally ? '是' : '否'} />
                    <Info
                      label="指纹"
                      value={loaded.fingerprint
                        ? <TechnicalId label="指纹" value={loaded.fingerprint} kind="fingerprint" />
                        : '尚未收敛'}
                    />
                    <Info
                      label="状态"
                      value={
                        <StatusBadge
                          label={loaded.deleting ? '清理中' : loaded.isActive ? '可用' : '停用'}
                          pending={imageInProgress(loaded)}
                          variant={loaded.isActive && !loaded.deleting ? 'success' : 'secondary'}
                        />
                      }
                    />
                    <Info label="最近更新" value={relativeTime(loaded.updatedAt)} />
                    {loaded.description ? (
                      <div className="sm:col-span-2">
                        <Info label="描述" value={loaded.description} />
                      </div>
                    ) : null}
                  </CardContent>
                </Card>
              </TabsContent>
              <TabsContent value="assignments" className="space-y-6">
                <SectionCard
                  title="服务器分配"
                  actions={
                    <ImageAssignSelect
                      imageAlias={loaded.alias}
                      servers={servers.filter((server) => !assignments.some((assignment) => assignment.serverId === server.id))}
                      disabled={assign.isPending || unassign.isPending || servers.length === 0 || loaded.deleting}
                      onAssign={(serverId) => assign.mutate({ serverId })}
                    />
                  }
                  flush={assignments.length > 0}
                >
                  <div data-testid="image-fingerprint-assignment">
                    {assignments.length === 0 ? (
                      <p className="text-sm text-muted-foreground">尚未分配到服务器。</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>服务器</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>指纹</TableHead>
                            <TableHead>最近观测</TableHead>
                            <TableHead className="text-right">操作</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {assignments.map((assignment) => (
                            <AssignmentRow
                              key={assignment.id}
                              assignment={assignment}
                              serverName={servers.find((server) => server.id === assignment.serverId)?.name ?? assignment.serverId}
                              onEnsure={() => assign.mutate({
                                serverId: assignment.serverId,
                                expectedGeneration: assignment.generation,
                              })}
                              onDelete={() => unassign.mutate({
                                serverId: assignment.serverId,
                                generation: assignment.generation,
                              })}
                              busy={assign.isPending || unassign.isPending}
                            />
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </div>
                </SectionCard>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">操作历史</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResourceIntentFailures listPath={`/admin/images/${loaded.id}/intents`} admin />
                    <ResourceIntentHistory listPath={`/admin/images/${loaded.id}/intents`} admin />
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          );
        }}
      </QueryView>
      <ConfirmDialog
        open={deleteOpen}
        title="移除镜像？"
        description="移除会先去掉各服务器上的指纹分配；仍被容器引用的镜像会由后端拒绝。"
        confirmLabel="确认移除"
        pendingLabel="提交中..."
        pending={deleteImage.isPending}
        onConfirm={() => deleteImage.mutate()}
        onOpenChange={setDeleteOpen}
      />
    </Page>
  );
}

function Info({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      {typeof value === 'string' ? (
        <p className={mono ? 'mt-1 break-all font-mono text-xs' : 'mt-1 break-all'}>{value}</p>
      ) : (
        <div className="mt-1">{value}</div>
      )}
    </div>
  );
}

function ImageAssignSelect({
  imageAlias,
  servers,
  disabled,
  onAssign,
}: {
  imageAlias: string;
  servers: Array<{ id: string; name: string }>;
  disabled: boolean;
  onAssign: (serverId: string) => void;
}) {
  const [resetKey, setResetKey] = useState(0);
  return (
    <Select
      key={resetKey}
      onValueChange={(serverId) => {
        onAssign(serverId);
        setResetKey((key) => key + 1);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="h-8 w-[220px] text-xs" aria-label={`为 ${imageAlias} 分配服务器`}>
        <SelectValue placeholder="添加服务器..." />
      </SelectTrigger>
      <SelectContent>
        {servers.map((server) => (
          <SelectItem key={server.id} value={server.id}>{server.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AssignmentRow({
  assignment,
  serverName,
  onEnsure,
  onDelete,
  busy,
}: {
  assignment: ImageAssignmentDto;
  serverName: string;
  onEnsure: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const ready = assignment.lifecyclePhase === 'active' && !assignment.needsAttention && assignment.managedFingerprint === assignment.observedFingerprint;
  const fingerprint = assignment.observedFingerprint ?? assignment.managedFingerprint;
  return (
    <TableRow>
      <TableCell>{serverName}</TableCell>
      <TableCell className="whitespace-normal">
        <StatusBadge
          label={ready ? '已同步' : lifecyclePhaseLabel(assignment.lifecyclePhase)}
          pending={assignmentInProgress(assignment)}
          variant={ready ? 'success' : assignment.needsAttention ? 'destructive' : 'warning'}
        />
        {assignment.failureReason || assignment.failureCode ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
            <CircleAlert className="h-3 w-3" />
            {assignment.failureReason ?? assignment.failureCode}
          </p>
        ) : null}
      </TableCell>
      <TableCell>
        {fingerprint
          ? <TechnicalId label="指纹" value={fingerprint} kind="fingerprint" />
          : <span className="text-sm">等待指纹</span>}
      </TableCell>
      <TableCell>{relativeTime(assignment.lastObservedAt)}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onEnsure} disabled={busy}>
            <RefreshCw className="h-3.5 w-3.5" />重新收敛
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>移除</Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
