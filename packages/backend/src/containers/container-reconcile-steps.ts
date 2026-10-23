import type { Logger } from '@nestjs/common';
import {
  compareManagedFields,
  deriveInstanceName,
  IncusError,
  type DesiredInstanceSpec,
  type IncusClientPort,
} from '../incus/index.js';
import type { CpuSetService } from '../cpu/cpu-sets.service.js';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import { resolveContainerRuntime } from './container-runtime.js';
import {
  buildContainerSpec,
  deletePhysicalInstance,
  managedContainerIdentity,
  MANAGED_FIELD_OWNERSHIP,
  normalized,
  observedDiskUsageBytes,
  orphanInstances,
  powerTransition,
  running,
  stopPhysicalInstance,
  toSpecAttachments,
  type ActualInstance,
  type InstanceFull,
  type InstanceState,
} from './container-instance-ops.js';
import type { ContainerReconcileStore, ContainerRow } from './container-reconcile.store.js';
import { decideRootShrink, type RootShrinkBlock } from './container-rules.js';

/*
 * Step functions of the container reconciler that need no Incus mutation
 * audit: the root-shrink decision, the SSH readiness wait policy and the
 * full scan. SQL stays in the store.
 */

// --- root disk shrink --------------------------------------------------------------

function rootBytes(document: { readonly devices?: unknown }): bigint | null {
  const devices = document.devices as Record<string, Record<string, unknown> | undefined> | undefined;
  return observedDiskUsageBytes(devices?.root?.size);
}

/** The shrink decision for this pass; `allow` when the root does not shrink. */
export function rootShrinkDecision(
  row: Pick<ContainerRow, 'root_resize_family'>,
  actual: ActualInstance,
  desired: DesiredInstanceSpec,
  usedBytes: bigint | null,
  isRunning: boolean,
): { decision: 'allow' | RootShrinkBlock; actualRoot: bigint | null; desiredRoot: bigint | null } {
  const actualRoot = rootBytes(actual.document);
  const desiredRoot = rootBytes(desired);
  if (actualRoot === null || desiredRoot === null) {
    return { decision: 'allow', actualRoot, desiredRoot };
  }
  return {
    decision: decideRootShrink({
      resizeFamily: row.root_resize_family,
      actualRootBytes: actualRoot,
      desiredRootBytes: desiredRoot,
      usedBytes,
      running: isRunning,
    }),
    actualRoot,
    desiredRoot,
  };
}

/**
 * Refuse a root-disk shrink that would lose data (or cannot be judged), and
 * revert (and park) the desired size so the container stops asking for it.
 */
export async function guardRootShrink(
  store: Pick<ContainerReconcileStore, 'revertImpossibleRootShrink'>,
  row: ContainerRow,
  actual: ActualInstance,
  desired: DesiredInstanceSpec,
  state: InstanceState,
  usedBytes: bigint | null,
): Promise<void> {
  const { decision, actualRoot, desiredRoot } = rootShrinkDecision(
    row,
    actual,
    desired,
    usedBytes,
    running(state),
  );
  if (decision === 'allow' || actualRoot === null || desiredRoot === null) return;
  const code = decision === 'requires_stop'
    ? 'ROOT_SHRINK_REQUIRES_STOP'
    : decision === 'usage_unknown'
      ? 'ROOT_USAGE_UNKNOWN'
      : 'ROOT_SHRINK_BELOW_USAGE';
  if (decision === 'usage_floor' || decision === 'usage_unknown') {
    await store.revertImpossibleRootShrink(row.id, row.revision, actualRoot, usedBytes, code);
  }
  throw new IncusError(code, 'managed_failure', {
    containerId: row.id,
    requestedBytes: desiredRoot.toString(),
    usedBytes: usedBytes?.toString() ?? null,
  });
}

// --- SSH readiness -------------------------------------------------------------------

/** How long a first boot waits for the image's sshd before settling without it. */
export const SSH_READY_WAIT_MS = 3 * 60_000;

/**
 * Only the first boot of a new container waits (bounded) for sshd to listen on
 * 127.0.0.1:22; any later intent, or a guest whose sshd was moved or stopped by
 * its user, settles with the observation recorded instead of retrying forever.
 */
export function awaitsSshDaemon(
  intent: Pick<IntentRecord, 'kind' | 'createdAt'>,
  now: number = Date.now(),
): boolean {
  if (intent.kind !== 'container.create') return false;
  const created = Date.parse(intent.createdAt);
  return Number.isFinite(created) && now - created < SSH_READY_WAIT_MS;
}

// --- full scan -----------------------------------------------------------------------

export interface ContainerScanDeps {
  readonly store: ContainerReconcileStore;
  readonly cpuSets: Pick<CpuSetService, 'resolve' | 'preview' | 'releaseIdle'>;
  readonly config: Pick<NyabaseConfigService, 'get'>;
  readonly logger: Pick<Logger, 'warn'>;
}

/** Full scan: queue update/delete intents for drifted containers and quarantine orphaned instances. */
export async function scanServerContainers(
  deps: ContainerScanDeps,
  serverId: string,
  client: IncusClientPort,
  signal: AbortSignal,
): Promise<void> {
  // Incus first, rows second: a row always exists before its instance, so an
  // instance created while the scan runs is never mistaken for an orphan.
  const instances = await client.listInstances(2, { signal });
  const documents = instances.metadata as InstanceFull[];
  const rows = await deps.store.listScanContainers(serverId);
  const known = new Set(
    rows
      .filter((row) => row.lifecycle_phase !== 'deleting')
      .map((row) => normalized(row.id)),
  );
  const byContainerId = new Map<string, ActualInstance>();
  for (const document of documents) {
    const identity = managedContainerIdentity(document);
    if (identity.managed && identity.serverId === normalized(serverId) && identity.containerId) {
      byContainerId.set(identity.containerId, { name: document.name ?? '', document });
    }
  }
  for (const desired of rows) {
    if (desired.needs_attention || desired.lifecycle_phase === 'failed') continue;
    if (desired.lifecycle_phase === 'deleting') {
      await deps.store.enqueueScanIntent(desired, 'container.delete');
      continue;
    }
    const actual = byContainerId.get(normalized(desired.id));
    const usage = observedDiskUsageBytes(actual?.document.state?.disk?.root?.usage);
    if (usage !== null) {
      await deps.store.recordRootUsage(desired.id, usage);
    }
    try {
      if (await scanNeedsUpdate(deps, desired, deriveInstanceName(desired.id), actual)) {
        await deps.store.enqueueScanIntent(desired, 'container.update');
      }
    } catch (error) {
      // One container that cannot be specified must not stop the scan of the others.
      deps.logger.warn(`Full scan could not check container ${desired.id}: ${String(error)}`);
    }
  }
  await quarantineOrphanInstances(deps, serverId, client, orphanInstances(documents, serverId, known));
  await deps.cpuSets.releaseIdle(serverId);
}

/**
 * An instance labelled as ours that no row owns is stopped at once (it may
 * hold an address the platform hands out again) but deleted only after the
 * quarantine: after a database restore every newer container looks like this.
 */
async function quarantineOrphanInstances(
  deps: ContainerScanDeps,
  serverId: string,
  client: IncusClientPort,
  orphans: readonly InstanceFull[],
): Promise<void> {
  const { fresh, due } = await deps.store.orphans.sight(
    serverId,
    'instance',
    orphans.map((document) => ({ poolName: '', name: document.name! })),
  );
  for (const orphan of fresh) {
    deps.logger.warn(
      `Orphan instance ${orphan.name} on server ${serverId} has no container row; `
      + 'stopping it and deleting it after the quarantine',
    );
  }
  const dueNames = new Set(due.map((orphan) => orphan.name));
  for (const document of orphans) {
    const name = document.name!;
    try {
      if (dueNames.has(name)) {
        await deletePhysicalInstance(client, name);
        await deps.store.orphans.forget(serverId, 'instance', { poolName: '', name });
        deps.logger.warn(`Deleted orphan instance ${name} on server ${serverId} after the quarantine`);
      } else {
        await stopPhysicalInstance(client, name);
      }
    } catch (error) {
      deps.logger.warn(`Orphan instance ${name} on server ${serverId}: ${String(error)}`);
    }
  }
}

/** Does the live instance differ from what the platform wants (name, power, managed fields)? */
async function scanNeedsUpdate(
  deps: ContainerScanDeps,
  row: {
    readonly id: string;
    readonly server_id: string;
    readonly power_intent: 'running' | 'stopped';
  },
  expectedName: string,
  actual: ActualInstance | undefined,
): Promise<boolean> {
  if (!actual) return true;
  if (actual.name !== expectedName) return true;
  const status = actual.document.state?.status ?? actual.document.status;
  if (powerTransition(status, row.power_intent) !== 'none') return true;
  const full = await deps.store.readContainer(row.id);
  if (!full?.parent_interface || !full.routed_ip || !full.network_key || !full.gateway) {
    return true;
  }
  const attachments = await deps.store.readAttachments(row.id, row.server_id);
  const desired = buildContainerSpec(
    full,
    toSpecAttachments(attachments.filter((attachment) => attachment.bind_state !== 'detaching')),
    await resolveContainerRuntime(deps.cpuSets, deps.config, full, 'preview'),
  );
  return compareManagedFields(actual.document, desired, MANAGED_FIELD_OWNERSHIP).kind !== 'empty';
}
