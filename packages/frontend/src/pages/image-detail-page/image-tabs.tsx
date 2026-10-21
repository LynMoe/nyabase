import { useState } from 'react';
import { CircleAlert, RefreshCw } from 'lucide-react';
import {
  IntentResourceType,
  type AdminImageDto,
  type ImageAssignmentDto,
  type ServerDto,
} from '@nyabase/common';
import { resourceIntentsPath } from '../../lib/intent-visibility.js';
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
import { Field } from '../../components/layout/field.js';
import { ResourceIntentFailures, ResourceIntentHistory } from '../../components/intents/resource-intent-failures.js';
import { formatBytes, relativeTime } from '../../lib/utils.js';
import { assignmentInProgress, imageInProgress } from '../../lib/in-progress.js';
import { lifecyclePhaseLabel } from '../../lib/display-labels.js';
import type { ImageMutations } from './use-image-mutations.js';

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

export function ImageAssignmentsTab({
  image,
  servers,
  mutations,
}: {
  image: AdminImageDto;
  servers: ServerDto[];
  mutations: ImageMutations;
}) {
  const { assign, unassign } = mutations;
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
            <RefreshCw className="h-3.5 w-3.5" />重新同步
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy}>移除</Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
