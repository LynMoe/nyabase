import { Link } from '@tanstack/react-router';
import { ChevronRight, CircleAlert, CirclePlay, CircleStop, LoaderCircle } from 'lucide-react';
import { canonicalPciAddress, ContainerPhase, type ContainerDto, type PerformanceServerUsage } from '@nyabase/common';
import { GpuStrip } from './gpu-strip.js';
import { useGpuNames } from '../performance/host-occupancy.js';
import { remainingLabel } from '../grants/use-grant-panel-data.js';
import {
  containerTone,
  DASHBOARD_CONTAINER_LIMIT,
  DASHBOARD_EXPIRY_SOON_MS,
  DASHBOARD_STALE_HINT_MS,
  type DashboardServer,
} from '../../lib/dashboard-servers.js';
import { freeGpuCount } from '../../lib/gpu-occupancy.js';
import { containerStatusLabel, lifecyclePhaseLabel } from '../../lib/status-labels.js';
import { cn, relativeTime } from '../../lib/utils.js';

const LABEL = 'w-11 shrink-0 text-xs text-muted-foreground';

/** One server on 概览: its granted GPUs with who uses them, the machine's load, and my containers there. */
export function ServerCard({ server }: { server: DashboardServer }) {
  const { access, grace, usage } = server;
  return (
    <section
      className={cn('min-w-0 space-y-4 rounded-lg border bg-card px-4 py-4 sm:px-5', grace && 'border-warning/40 bg-warning/5')}
      data-testid="dashboard-server"
    >
      <ServerHeader server={server} />
      {access && server.gpus.length > 0 ? <GpuRow server={server} /> : null}
      {access ? <HostLoad usage={server.online ? usage : null} /> : null}
      {grace ? (
        <p className="text-sm text-warning tabular-nums">{new Date(grace.purgeAt).toLocaleString('zh-CN')} 清除</p>
      ) : null}
      <MyContainers containers={server.containers} />
    </section>
  );
}

function ServerHeader({ server }: { server: DashboardServer }) {
  const { access, grace, usage } = server;
  const lagging = usage?.stale && usage.sampledAt && Date.now() - Date.parse(usage.sampledAt) > DASHBOARD_STALE_HINT_MS
    ? usage.sampledAt
    : null;
  const expiresAt = access?.expiresAt ?? null;
  const soon = expiresAt && new Date(expiresAt).getTime() - Date.now() <= DASHBOARD_EXPIRY_SOON_MS
    ? remainingLabel(expiresAt)
    : null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', server.online ? 'bg-success' : 'bg-muted-foreground/50')} />
      <h2 className="truncate text-base font-semibold">{server.name}</h2>
      {!server.online ? <span className="shrink-0 text-xs text-muted-foreground">离线</span> : null}
      {server.online && lagging ? (
        <span className="shrink-0 text-xs text-muted-foreground">数据 {relativeTime(lagging)}</span>
      ) : null}
      {soon ? <span className="shrink-0 text-xs text-warning">{soon}后到期</span> : null}
      {grace ? <span className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">宽限中</span> : null}
      {access ? (
        <Link
          to="/usage"
          search={{ serverId: server.serverId }}
          className="ml-auto shrink-0 text-sm text-primary hover:underline"
        >
          使用情况 →
        </Link>
      ) : null}
    </div>
  );
}

function GpuRow({ server }: { server: DashboardServer }) {
  const names = useGpuNames(server.gpuEnabled ? server.serverId : undefined, 'mine');
  const model = gpuModel(names, server.gpus[0]?.pci);
  const free = freeGpuCount(server.gpus);
  const known = server.gpus.some((card) => card.state !== 'unknown');
  // Phone: label and count on one line, the squares on the next; wider: one row.
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 sm:flex-nowrap">
      <span className={LABEL}>GPU</span>
      <GpuStrip cards={server.gpus} model={model} className="order-last w-full sm:order-none sm:w-auto" />
      {known ? (
        <span className="ml-auto flex shrink-0 items-baseline gap-1 whitespace-nowrap sm:pl-2" data-testid="dashboard-gpu-free">
          <span className={cn('text-2xl font-semibold leading-none tabular-nums', free > 0 ? 'text-success' : 'text-muted-foreground')}>
            {free}
          </span>
          <span className="text-xs text-muted-foreground">/ {server.gpus.length} 空闲</span>
        </span>
      ) : null}
    </div>
  );
}

function HostLoad({ usage }: { usage: PerformanceServerUsage | null }) {
  const host = usage?.host;
  return (
    <div className="flex items-center gap-1.5">
      <span className={LABEL}>整机</span>
      <div className="flex min-w-0 flex-1 gap-5">
        <LoadBar label="CPU" ratio={host?.cpuRatio ?? null} />
        <LoadBar label="内存" ratio={host?.memory.ratio ?? null} />
      </div>
    </div>
  );
}

function LoadBar({ label, ratio }: { label: string; ratio: number | null }) {
  const percent = ratio === null ? null : Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
      <span className="shrink-0">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        {percent === null ? null : (
          <div className={cn('h-full rounded-full', percent >= 85 ? 'bg-warning' : 'bg-foreground/60')} style={{ width: `${percent}%` }} />
        )}
      </div>
      <span className="w-9 shrink-0 text-right tabular-nums">{percent === null ? '—' : `${percent}%`}</span>
    </div>
  );
}

function MyContainers({ containers }: { containers: readonly ContainerDto[] }) {
  const shown = containers.slice(0, DASHBOARD_CONTAINER_LIMIT);
  const more = containers.length - shown.length;
  return (
    <div className="flex items-start gap-1.5">
      <span className={cn(LABEL, 'pt-1.5')}>我的</span>
      <div className="min-w-0 flex-1">
        {shown.length === 0 ? <p className="pt-1 text-sm text-muted-foreground">没有容器</p> : null}
        <ul className="-mx-2">
          {shown.map((container) => (
            <li key={container.id}>
              <ContainerRow container={container} />
            </li>
          ))}
          {more > 0 ? (
            <li>
              <Link to="/containers" className="block rounded-md px-2 py-1.5 text-sm text-primary hover:bg-accent">
                还有 {more} 个 →
              </Link>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

const TONE = {
  running: { icon: CirclePlay, className: 'text-success' },
  attention: { icon: CircleAlert, className: 'text-destructive' },
  pending: { icon: LoaderCircle, className: 'animate-spin text-warning' },
  idle: { icon: CircleStop, className: 'text-muted-foreground' },
} as const;

/** Status icon, then the name; the whole row opens the container. */
function ContainerRow({ container }: { container: ContainerDto }) {
  const tone = TONE[containerTone(container)];
  const Icon = tone.icon;
  const status = container.lifecyclePhase === ContainerPhase.Active
    ? containerStatusLabel(container.actual.status)
    : lifecyclePhaseLabel(container.lifecyclePhase);
  return (
    <Link
      to="/containers/$containerId"
      params={{ containerId: container.id }}
      search={{ tab: 'overview' }}
      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
    >
      <Icon role="img" aria-label={status} className={cn('h-4 w-4 shrink-0', tone.className)}>
        <title>{status}</title>
      </Icon>
      <span className="min-w-0 truncate font-medium">{container.name}</span>
      <ChevronRight aria-hidden className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Link>
  );
}

function gpuModel(names: ReadonlyMap<string, string>, pci: string | undefined): string | null {
  if (!pci) return null;
  const key = canonicalPciAddress(pci) ?? pci.trim().toLowerCase();
  for (const [address, model] of names) {
    if ((canonicalPciAddress(address) ?? address) === key) return model;
  }
  return null;
}
