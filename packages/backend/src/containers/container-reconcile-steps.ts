import type { Logger } from '@nestjs/common';
import { FailureCode } from '@nyabase/common';
import {
  compareManagedFields,
  deriveInstanceName,
  IncusError,
  isMissingCustomVolumeError,
  type DesiredInstanceSpec,
  type IncusClientPort,
} from '../incus/index.js';
import type { CpuSetService } from '../cpu/cpu-sets.service.js';
import type { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import {
  failedOutcome,
  type ReconcileOutcome,
  type ReconcileRunContext,
} from '../reconcile/managed-reconciler.js';
import {
  VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS,
  ensureSharedCatalogOnServer,
} from '../volumes/shared-volume-catalog.service.js';
import { resolveContainerRuntime } from './container-runtime.js';
import {
  buildContainerSpec,
  deletePhysicalInstance,
  isNotFound,
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
import type {
  ContainerAttachment,
  ContainerReconcileStore,
  ContainerRow,
} from './container-reconcile.store.js';
import { decideRootShrink, isRestartIntent, type RootShrinkBlock } from './container-rules.js';

/*
 * Step functions of the container reconciler that need no Incus mutation
 * audit: the root-shrink decision, the SSH readiness wait policy, the full
 * scan and the attachment preparation. SQL stays in the store.
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
    if (actual?.document.state?.status) {
      // Routes store the ContainerStatus form (`running`) of Incus's `Running`.
      await deps.store.confirmRouteObservation(desired.id, actual.name, actual.document.state.status.toLowerCase());
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

// --- attachments ------------------------------------------------------------------

/**
 * Consecutive passes of each intent that found an attached volume not ready
 * (placement pending, catalog adopt pending). The intent's attempt count also
 * grows on unreachable-server and busy retries, so a create held through an
 * agent restart would fail at its first not-ready pass after the reconnect.
 * Kept in memory: the backend is one process and runs an intent on one chain
 * at a time; a restart only starts the count over (the failure comes later).
 */
export class NotReadyPasses {
  private readonly passes = new Map<string, number>();

  constructor(private readonly capacity = 4_096) {}

  /** Counts one not-ready pass of the intent and returns its consecutive passes. */
  record(intentId: string): number {
    const count = (this.passes.get(intentId) ?? 0) + 1;
    this.passes.delete(intentId);
    this.passes.set(intentId, count);
    // Intents settled elsewhere (superseded, deleted) leave entries behind: drop the oldest.
    while (this.passes.size > this.capacity) {
      this.passes.delete(this.passes.keys().next().value!);
    }
    return count;
  }

  clear(intentId: string): void {
    this.passes.delete(intentId);
  }
}

const NOT_READY_FAILURES: Readonly<Record<string, { code: string; message: string }>> = {
  VOLUME_PLACEMENT_PENDING: {
    code: FailureCode.VolumePlacementFailed,
    message: 'An attached volume is still not present on the container\'s server',
  },
  VOLUME_CATALOG_ADOPT_PENDING: {
    code: FailureCode.VolumeCatalogAdoptFailed,
    message: 'Incus did not adopt the existing CephFS directory into this daemon catalog',
  },
};

export interface AttachmentDeps {
  readonly store: Pick<
    ContainerReconcileStore,
    'rereadDesired' | 'markCatalogPresent' | 'requeueResizeAfterCatalogPost' | 'requeueEnsureForUnshiftedCatalog'
  >;
  readonly logger: Pick<Logger, 'log'>;
  readonly notReady: NotReadyPasses;
}

/**
 * The attachments the instance must carry, with their catalogs present on the
 * server. An outcome means the intent became stale or must end here: a
 * volume still not ready after as many consecutive passes as a catalog adopt
 * gets fails the intent visibly instead of retrying it forever.
 */
export async function prepareAttachments(
  deps: AttachmentDeps,
  context: ReconcileRunContext,
  client: IncusClientPort,
  row: ContainerRow,
): Promise<{ outcome: ReconcileOutcome } | { attachments: ContainerAttachment[] }> {
  const intentId = context.intent.id;
  let prepared: Awaited<ReturnType<typeof readyAttachments>>;
  try {
    prepared = await readyAttachments(deps, context, client, row);
  } catch (error) {
    const failure = error instanceof IncusError ? NOT_READY_FAILURES[error.code] : undefined;
    if (!failure || deps.notReady.record(intentId) <= VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS) throw error;
    deps.notReady.clear(intentId);
    return {
      outcome: failedOutcome(failure.code, failure.message, {
        ...(error as IncusError).details,
        serverId: row.server_id,
      }),
    };
  }
  deps.notReady.clear(intentId);
  return prepared;
}

async function readyAttachments(
  deps: AttachmentDeps,
  context: ReconcileRunContext,
  client: IncusClientPort,
  row: ContainerRow,
): Promise<{ outcome: ReconcileOutcome } | { attachments: ContainerAttachment[] }> {
  const beforeMkdir = await deps.store.rereadDesired(
    row.id,
    row.server_id,
    context.intent.targetRevision,
  );
  if (beforeMkdir.stale && !isRestartIntent(context.intent.kind, context.intent.request)) {
    return {
      outcome: { outcome: 'succeeded', observedRevision: context.intent.targetRevision, stale: true },
    };
  }
  await ensureDesiredCatalogs(deps, context, client, beforeMkdir.desired, row.server_id);
  const beforePut = await deps.store.rereadDesired(
    row.id,
    row.server_id,
    context.intent.targetRevision,
  );
  return { attachments: beforePut.desired };
}

/**
 * Every volume the instance mounts must already exist in this daemon's Incus
 * catalog before the instance PUT, or Incus rejects the device.
 */
async function ensureDesiredCatalogs(
  deps: AttachmentDeps,
  context: ReconcileRunContext,
  client: IncusClientPort,
  attachments: readonly ContainerAttachment[],
  serverId: string,
): Promise<void> {
  for (const attachment of attachments) {
    if (!attachment.pool_name) {
      throw new IncusError(
        attachment.shared ? 'VOLUME_PLACEMENT_PENDING' : 'MISSING_STORAGE_POOL',
        attachment.shared ? 'retry' : 'managed_failure',
        { volumeId: attachment.volume_id, serverId },
      );
    }
    if (attachment.shared) {
      const result = await ensureSharedCatalogOnServer(client, {
        poolName: attachment.pool_name,
        incusName: attachment.incus_name,
        sizeBytes: attachment.size_bytes,
        ownerScope: attachment.shared_backend_id ?? null,
      });
      if (result === 'unshifted') await deps.store.requeueEnsureForUnshiftedCatalog(attachment.volume_id, serverId);
      if (result === 'missing' || result === 'unshifted') {
        throw new IncusError('VOLUME_CATALOG_ADOPT_PENDING', 'retry', {
          volumeId: attachment.volume_id,
          serverId,
        });
      }
      await deps.store.markCatalogPresent(attachment.volume_id, serverId);
      if (result === 'posted') {
        // Created at the size read before the POST: verify it at the current one.
        await deps.store.requeueResizeAfterCatalogPost(attachment.volume_id, serverId, attachment.size_bytes);
      }
      deps.logger.log(
        `container=${context.intent.resourceId} ensure shared catalog volume=${attachment.volume_id} `
        + `server=${serverId} result=${result}`,
      );
      continue;
    }
    try {
      await client.getStorageVolume(attachment.pool_name, 'custom', attachment.incus_name);
      await deps.store.markCatalogPresent(attachment.volume_id, serverId);
    } catch (error) {
      if (error instanceof IncusError && error.code === 'MISSING_STORAGE_POOL') {
        throw error;
      }
      if (isNotFound(error) || isMissingCustomVolumeError(error)) {
        deps.logger.log(
          `Custom volume ${attachment.incus_name} is not present on ${serverId}`,
        );
        throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
          volumeId: attachment.volume_id,
          reason: 'preflight',
        });
      }
      throw error;
    }
  }
}
