import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Role, type ContainerDto, type ListScope, type PerformanceSelfResponse } from '@nyabase/common';
import { Link } from '@tanstack/react-router';
import { ChartLine, Pencil } from 'lucide-react';
import { useHasRole } from '../../lib/use-role.js';
import { LimitsDialog } from './spec-panel.js';
import { SshLoginCard } from './ssh-login.js';
import { Button } from '../ui/button.js';
import { SectionCard } from '../layout/section-card.js';
import { UsageMeter } from '../performance/usage-meter.js';
import { TechnicalId } from '../refs/technical-id.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { queryPollInterval } from '../../lib/query-lifecycle.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { formatRate } from '../../lib/utils.js';
import {
  cpuReading,
  gpuReading,
  liveSample,
  memoryReading,
  rootDiskReading,
  type ContainerLiveUsage,
} from '../../lib/container-usage.js';
import { ContainerOverviewGpu } from '../gpu/gpu-sections.js';

export function OverviewPanel({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  return (
    <div className="space-y-4" data-testid="container-overview">
      <SshLoginCard container={container} scope={scope} />
      <SpecCard container={container} scope={scope} onEdit={() => setLimitsOpen(true)} />
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

/**
 * The container's specification read against its live usage: each resource is
 * one "used / allocated" meter, so the size and how full it is sit together.
 */
function SpecCard({
  container,
  scope,
  onEdit,
}: {
  container: ContainerDto;
  scope: ListScope;
  onEdit: () => void;
}) {
  const admin = scope === 'all';
  const canViewMetrics = useHasRole(Role.UserAdmin);
  const metricsDenied = admin && !canViewMetrics;
  const { data: occupancy } = useQuery({
    queryKey: queryKeys.performance.self(scope, container.id),
    queryFn: () => api.get<PerformanceSelfResponse>(scopedPath('/performance/usage', scope, { containerId: container.id })),
    enabled: !metricsDenied,
    refetchInterval: (query) => queryPollInterval(query.state, { activeIntervalMs: 15_000 }),
  });
  const sample = liveSample(container, occupancy?.container);
  const stale = sample !== undefined && occupancy?.stale === true;
  const usagePath = admin ? '/manage/containers/$containerId/usage' : '/containers/$containerId/usage';
  return (
    <SectionCard
      title="规格"
      testId="container-spec-card"
      description={metricsDenied ? '无指标权限' : stale ? '数据可能已过时' : undefined}
      actions={(
        <>
          {metricsDenied ? null : (
            <Button asChild variant="ghost" size="sm">
              <Link to={usagePath} params={{ containerId: container.id }}>
                <ChartLine className="h-4 w-4" />图表
              </Link>
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={onEdit} data-testid="edit-container-spec">
            <Pencil className="h-4 w-4" />编辑
          </Button>
        </>
      )}
    >
      <div className="grid gap-x-10 gap-y-5 sm:grid-cols-2">
        <UsageMeter label="CPU" reading={cpuReading(container, sample)} stale={stale} testId="spec-cpu" />
        <UsageMeter label="内存" reading={memoryReading(container, sample)} stale={stale} testId="spec-memory" />
        <UsageMeter label="系统盘" reading={rootDiskReading(container, sample)} stale={stale} testId="spec-root-disk" />
        {container.gpu ? (
          <UsageMeter
            label="GPU"
            reading={gpuReading(container, sample) ?? { used: null, total: null, ratio: null, lead: '无显卡' }}
            stale={stale}
            detail={<ContainerOverviewGpu gpu={container.gpu} serverId={container.serverId} scope={scope} />}
            testId="spec-gpu"
          />
        ) : null}
      </div>
      <SpecFootnote container={container} sample={sample} />
    </SectionCard>
  );
}

/** Network rates and the image: context, not capacity, so they sit quietly under the meters. */
function SpecFootnote({ container, sample }: { container: ContainerDto; sample: ContainerLiveUsage | undefined }) {
  const rate = (value: number | null | undefined) => (value == null ? '—' : formatRate(value));
  return (
    <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 border-t pt-4 text-xs">
      <div className="flex items-baseline gap-2">
        <dt className="text-muted-foreground">网络</dt>
        <dd className="tabular-nums">
          <span className="text-muted-foreground">↓</span> {rate(sample?.network.rxBytesPerSec)}
          <span className="ml-3 text-muted-foreground">↑</span> {rate(sample?.network.txBytesPerSec)}
        </dd>
      </div>
      <div className="flex min-w-0 items-baseline gap-2">
        <dt className="shrink-0 text-muted-foreground">镜像</dt>
        <dd className="min-w-0">
          {container.imageFingerprint ? (
            <TechnicalId
              label="镜像"
              kind="fingerprint"
              alias={container.imageName}
              value={container.imageFingerprint}
              visible={container.imageName?.trim() || undefined}
              className="inline max-w-full truncate text-xs text-foreground"
            />
          ) : (container.imageName ?? '同步中')}
        </dd>
      </div>
    </dl>
  );
}
