import { useState } from 'react';
import type {
  ContainerDto,
  GpuGrant,
  ListScope,
  PatchContainerLimitsRequest,
  PerformanceSelfResponse,
} from '@nyabase/common';
import { Link } from '@tanstack/react-router';
import { ChartLine, Pencil } from 'lucide-react';
import { useAuthStore } from '../../store/auth.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { LimitsDialog } from './spec-panel.js';
import { SshConfigDialog } from './ssh-login.js';
import { SshLoginCard } from './ssh-login.js';
import { useSshLogin } from './ssh-login.js';
import { Button } from '../ui/button.js';
import { SectionCard } from '../layout/section-card.js';
import { Field, FieldGrid } from '../layout/form-field.js';
import { TechnicalId } from '../refs/technical-id.js';
import { formatBytesCompact, formatCpu, formatRate } from '../../lib/utils.js';
import { ContainerOverviewGpu } from '../gpu/gpu-sections.js';

export function OverviewPanel({
  container,
  scope,
  gpuEnabled,
  gpuGrant,
  onRepairSsh,
  repairPending,
  onLimits,
  limitsPending,
  onGpuSubmit,
  gpuPending,
  occupancy,
  occupancyDenied,
}: {
  container: ContainerDto;
  scope: ListScope;
  gpuEnabled: boolean;
  gpuGrant: GpuGrant | null;
  onRepairSsh: () => void;
  repairPending: boolean;
  onLimits: (body: PatchContainerLimitsRequest) => Promise<unknown>;
  limitsPending: boolean;
  onGpuSubmit: (pciAddresses: string[]) => Promise<unknown>;
  gpuPending: boolean;
  occupancy?: PerformanceSelfResponse;
  occupancyDenied?: boolean;
}) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const authUser = useAuthStore((state) => state.user);
  const admin = scope === 'all';
  const ownContainer = !admin || (authUser !== null && container.ownerId === authUser.id);
  const sshKeys = useMySshKeys(ownContainer);
  const login = useSshLogin(container);

  return (
    <div className="space-y-4" data-testid="container-overview">
      <SshLoginCard
        container={container}
        login={login}
        showKeyNotice={ownContainer && sshKeys.missing}
        repairPending={repairPending}
        onRepairSsh={onRepairSsh}
        onShowConfig={() => setConfigOpen(true)}
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SpecCard container={container} scope={scope} onEdit={() => setLimitsOpen(true)} />
        <UsageCard
          containerId={container.id}
          admin={admin}
          occupancy={occupancy}
          occupancyDenied={occupancyDenied}
        />
      </div>
      <SshConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        containerName={container.name}
        login={login}
      />
      {limitsOpen ? (
        <LimitsDialog
          container={container}
          scope={scope}
          gpuEnabled={gpuEnabled}
          gpuGrant={gpuGrant}
          pending={limitsPending}
          gpuPending={gpuPending}
          onLimits={onLimits}
          onGpuSubmit={onGpuSubmit}
          onOpenChange={(open) => { if (!open) setLimitsOpen(false); }}
        />
      ) : null}
    </div>
  );
}

function rate(value: number | null): string {
  return value === null ? '—' : formatRate(value);
}

export function SpecCard({
  container,
  scope,
  onEdit,
}: {
  container: ContainerDto;
  scope: ListScope;
  onEdit: () => void;
}) {
  return (
    <SectionCard
      title="规格"
      actions={(
        <Button size="sm" variant="outline" onClick={onEdit} data-testid="edit-container-spec">
          <Pencil className="h-4 w-4" />编辑
        </Button>
      )}
    >
      <FieldGrid>
        <Field
          label="镜像"
          value={container.imageFingerprint
            ? (
              <TechnicalId
                label="镜像"
                kind="fingerprint"
                alias={container.imageName}
                value={container.imageFingerprint}
                visible={container.imageName?.trim() || undefined}
              />
            )
            : (container.imageName ?? '同步中')}
        />
        <Field label="CPU" value={formatCpu(container.cpuMillis)} />
        <Field label="内存" value={formatBytesCompact(container.memBytes)} />
        <Field label="系统盘" value={formatBytesCompact(container.rootSizeBytes)} />
        <Field label="实例名" value={container.instanceName ?? '创建中'} mono />
        <ContainerOverviewGpu gpu={container.gpu} serverId={container.serverId} scope={scope} />
      </FieldGrid>
    </SectionCard>
  );
}

export function UsageCard({
  containerId,
  admin,
  occupancy,
  occupancyDenied,
}: {
  containerId: string;
  admin: boolean;
  occupancy?: PerformanceSelfResponse;
  occupancyDenied?: boolean;
}) {
  const usage = occupancy?.container;
  const gpuUsed = usage?.gpu.usedBytes ?? null;
  const gpuText = usage && (usage.gpu.pciAddresses.length > 0 || gpuUsed !== null) && gpuUsed !== null
    ? formatBytesCompact(gpuUsed)
    : null;
  const usagePath = admin ? '/manage/containers/$containerId/usage' : '/containers/$containerId/usage';
  return (
    <SectionCard
      title="实时占用"
      description={occupancy?.stale ? '数据可能已过时' : undefined}
      actions={(
        <Button asChild variant="ghost" size="sm">
          <Link to={usagePath} params={{ containerId }}>
            <ChartLine className="h-4 w-4" />图表
          </Link>
        </Button>
      )}
    >
      {occupancyDenied ? <p className="text-sm text-muted-foreground">没有查看指标的权限</p> : (
        <FieldGrid>
          <Field label="CPU" value={usage?.cpu.usageCores == null ? null : `${usage.cpu.usageCores.toFixed(1)} 核`} />
          <Field label="内存" value={usage?.memory.usedBytes == null ? null : formatBytesCompact(usage.memory.usedBytes)} />
          <Field label="磁盘" value={usage?.disk.usedBytes == null ? null : formatBytesCompact(usage.disk.usedBytes)} />
          <Field label="网络 ↓ / ↑" value={usage ? `${rate(usage.network.rxBytesPerSec)} / ${rate(usage.network.txBytesPerSec)}` : null} />
          {gpuText ? <Field label="显存" value={gpuText} /> : null}
        </FieldGrid>
      )}
    </SectionCard>
  );
}
