import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Capability, type ContainerDto, type ListScope, type PerformanceSelfResponse } from '@nyabase/common';
import { Link } from '@tanstack/react-router';
import { ChartLine, Pencil } from 'lucide-react';
import { useAuthStore } from '../../store/auth.js';
import { LimitsDialog } from './spec-panel.js';
import { SshLoginCard } from './ssh-login.js';
import { Button } from '../ui/button.js';
import { SectionCard } from '../layout/section-card.js';
import { Field, FieldGrid } from '../layout/form-field.js';
import { TechnicalId } from '../refs/technical-id.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { formatBytesCompact, formatCpu, formatRate } from '../../lib/utils.js';
import { ContainerOverviewGpu } from '../gpu/gpu-sections.js';

export function OverviewPanel({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  return (
    <div className="space-y-4" data-testid="container-overview">
      <SshLoginCard container={container} scope={scope} />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SpecCard container={container} scope={scope} onEdit={() => setLimitsOpen(true)} />
        <UsageCard containerId={container.id} scope={scope} />
      </div>
      {limitsOpen ? (
        <LimitsDialog
          container={container}
          scope={scope}
          onOpenChange={(open) => { if (!open) setLimitsOpen(false); }}
        />
      ) : null}
    </div>
  );
}

function rate(value: number | null): string {
  return value === null ? '—' : formatRate(value);
}

function SpecCard({
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

function UsageCard({ containerId, scope }: { containerId: string; scope: ListScope }) {
  const admin = scope === 'all';
  const canViewMetrics = useAuthStore((state) => state.user?.capabilities.includes(Capability.ViewMetricsAll) ?? false);
  const occupancyDenied = admin && !canViewMetrics;
  const { data: occupancy } = useQuery({
    queryKey: queryKeys.performance.self(scope, containerId),
    queryFn: () => api.get<PerformanceSelfResponse>(scopedPath('/performance/usage', scope, { containerId })),
    enabled: !occupancyDenied,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
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
