import { Link } from '@tanstack/react-router';
import { ChartLine, Pencil } from 'lucide-react';
import type { ContainerDto, ListScope, PerformanceSelfResponse } from '@nyabase/common';
import { Button } from '../../ui/button.js';
import { SectionCard } from '../../layout/section-card.js';
import { Field, FieldGrid } from '../../layout/field.js';
import { TechnicalId } from '../../refs/technical-id.js';
import { formatBytesCompact, formatCpu, formatRate } from '../../../lib/utils.js';
import { ContainerOverviewGpu } from '../../gpu/gpu-sections.js';


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
