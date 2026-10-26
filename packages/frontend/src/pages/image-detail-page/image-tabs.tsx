import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { CircleAlert, RefreshCw, Trash2 } from 'lucide-react';
import {
  IntentResourceType,
  type AdminImageDto,
  type ImageAssignmentDto,
  type IntentAcceptedDto,
  type ServerDto,
} from '@nyabase/common';
import { resourceIntentsPath } from '../../lib/intent-visibility.js';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { queryKeys } from '../../lib/query-keys.js';
import { toast } from '../../hooks/use-toast.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { MoreActions } from '../../components/layout/more-actions.js';
import { Button } from '../../components/ui/button.js';
import { StatusBadge } from '../../components/layout/status-badge.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { Field } from '../../components/layout/form-field.js';
import { ResourceIntentFailures, ResourceIntentHistory } from '../../components/intents/resource-intent-failures.js';
import { formatBytes, relativeTime } from '../../lib/utils.js';
import { assignmentInProgress, imageInProgress } from '../../lib/in-progress.js';
import { lifecyclePhaseLabel } from '../../lib/display-labels.js';

export function ImageOverviewTab({ image }: { image: AdminImageDto }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <CardTitle className="text-base">身份</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
        <Field
          label="别名"
          value={image.alias.length > 64
            ? <TechnicalId label="别名" value={image.alias} kind="text" />
            : <span className="font-mono text-xs">{image.alias}</span>}
        />
        <Field label="登录用户" value={image.loginUser} mono />
        <Field label="最小系统盘" value={image.minRootSizeBytes === null ? '未设置' : formatBytes(image.minRootSizeBytes)} />
        <Field label="网络由平台管理" value={image.networkManagedExternally ? '是' : '否'} />
        <Field
          label="指纹"
          value={image.fingerprint
            ? <TechnicalId label="指纹" value={image.fingerprint} kind="fingerprint" />
            : '同步中'}
        />
        <Field
          label="状态"
          value={
            <StatusBadge
              label={image.deleting ? '清理中' : image.isActive ? '可用' : '停用'}
              pending={imageInProgress(image)}
              variant={image.isActive && !image.deleting ? 'success' : 'secondary'}
            />
          }
        />
        <Field label="最近更新" value={relativeTime(image.updatedAt)} />
        {image.description ? (
          <div className="sm:col-span-2">
            <Field label="描述" value={image.description} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

type AssignmentResponse = {
  assignment: ImageAssignmentDto;
  intent?: IntentAcceptedDto;
};

/** Refresh the image, the image list and its operation history after a change. */
function useInvalidateImage(id: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.detail(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.versions(id) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.images.admin });
    void queryClient.invalidateQueries({ queryKey: ['resource-intent-failures'] });
  };
}

/** Re-pull and remove, in the page header. */
export function ImageHeaderActions({ image }: { image: AdminImageDto }) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const navigate = useNavigate({ from: '/images/$id' });
  const invalidate = useInvalidateImage(image.id);
  const repullImage = useMutation({
    mutationFn: () => api.post<unknown>(`/images/${image.id}/repull`),
    onSuccess: () => {
      toast({ title: '已开始拉取最新版本', description: '新建容器将使用新版本，已有容器保持原版本' });
      invalidate();
    },
    onError: (error) => toast({ title: '拉取最新版本失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const deleteImage = useMutation({
    mutationFn: () => api.delete<unknown>(`/images/${image.id}`),
    onSuccess: () => {
      toast({ title: '已开始移除镜像' });
      setDeleteOpen(false);
      invalidate();
      void navigate({ to: '/images' });
    },
    onError: (error) => toast({ title: '删除失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <>
      <Button variant="outline" onClick={() => repullImage.mutate()} disabled={repullImage.isPending}>
        <RefreshCw className="h-4 w-4" />拉取最新版本
      </Button>
      <MoreActions actions={[{ label: '移除镜像', icon: Trash2, destructive: true, onSelect: () => setDeleteOpen(true) }]} />
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
    </>
  );
}

export function ImageAssignmentsTab({ image }: { image: AdminImageDto }) {
  const servers = useQuery({
    queryKey: queryKeys.servers.admin,
    queryFn: () => api.get<ServerDto[]>('/servers?scope=all'),
  }).data ?? [];
  const invalidate = useInvalidateImage(image.id);
  const assign = useMutation({
    mutationFn: ({ serverId, expectedRevision }: { serverId: string; expectedRevision?: number }) =>
      api.put<AssignmentResponse>(
        `/images/${image.id}/assignments/${serverId}`,
        expectedRevision ? { expectedRevision } : {},
      ),
    onSuccess: (result) => {
      toast({ title: '已开始分配镜像', description: result.intent ? `操作 ${result.intent.intentId.slice(0, 8)}` : undefined });
      invalidate();
    },
    onError: (error) => toast({ title: '镜像分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const unassign = useMutation({
    mutationFn: ({ serverId, revision }: { serverId: string; revision: number }) =>
      api.delete<AssignmentResponse>(`/images/${image.id}/assignments/${serverId}?expectedRevision=${revision}`),
    onSuccess: () => {
      toast({ title: '已开始取消分配镜像' });
      invalidate();
    },
    onError: (error) => toast({ title: '取消分配失败', description: errorMessage(error), variant: 'destructive' }),
  });
  const assignments = image.assignments ?? [];
  const busy = assign.isPending || unassign.isPending;
  // Never fetched while the image has no assignments.
  const assignmentIntentsPath = resourceIntentsPath(
    'all',
    IntentResourceType.ImageAssignment,
    assignments.length > 0 ? assignments.map((assignment) => assignment.id) : 'none',
  );
  return (
    <>
      <SectionCard
        title="服务器分配"
        actions={
          <ImageAssignSelect
            imageAlias={image.alias}
            servers={servers.filter((server) => !assignments.some((assignment) => assignment.serverId === server.id))}
            disabled={busy || servers.length === 0 || image.deleting}
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
                      expectedRevision: assignment.revision,
                    })}
                    onDelete={() => unassign.mutate({
                      serverId: assignment.serverId,
                      revision: assignment.revision,
                    })}
                    busy={busy}
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
          <ResourceIntentFailures
            listPath={assignmentIntentsPath}
            scope="all"
            enabled={image.assignments.length > 0}
          />
          <ResourceIntentHistory
            listPath={assignmentIntentsPath}
            scope="all"
            enabled={image.assignments.length > 0}
          />
        </CardContent>
      </Card>
    </>
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
      disabled={disabled || servers.length === 0}
    >
      <SelectTrigger
        className="h-8 w-[220px] text-xs"
        aria-label={`为 ${imageAlias} 分配服务器`}
        title={servers.length === 0 ? '所有服务器都已分配这个镜像' : undefined}
      >
        <SelectValue placeholder={servers.length === 0 ? '没有可分配的服务器' : '添加服务器...'} />
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
            <RefreshCw className="h-3.5 w-3.5" />重新同步
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>移除</Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
