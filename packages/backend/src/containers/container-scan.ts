import { compareManagedFields, deriveInstanceName, type IncusClientPort } from '../incus/index.js';
import { buildContainerSpec, toSpecAttachments } from './container-desired-spec.js';
import { deletePhysicalInstance } from './container-instance-ops.js';
import type { ContainerReconcileDeps } from './container-reconcile-deps.js';
import {
  MANAGED_FIELD_OWNERSHIP,
  bytes,
  managedContainerIdentity,
  normalized,
  powerTransition,
  type ActualInstance,
  type InstanceFull,
} from './container-reconcile-support.js';

/** Does the live instance differ from what the platform wants (name, power, managed fields)? */
async function scanNeedsUpdate(
  deps: ContainerReconcileDeps,
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
  );
  return compareManagedFields(actual.document, desired, MANAGED_FIELD_OWNERSHIP).kind !== 'empty';
}

/** Managed instances on the server keyed by the container id in their identity config. */
function indexManagedInstances(
  documents: readonly InstanceFull[],
  serverId: string,
): Map<string, ActualInstance> {
  const byContainerId = new Map<string, ActualInstance>();
  for (const document of documents) {
    const identity = managedContainerIdentity(document);
    if (
      identity.managed
      && identity.serverId === normalized(serverId)
      && identity.containerId
    ) {
      byContainerId.set(identity.containerId, { name: document.name ?? '', document });
    }
  }
  return byContainerId;
}

/** Full scan: queue update/delete intents for drifted containers and remove orphaned instances. */
export async function scanServerContainers(
  deps: ContainerReconcileDeps,
  serverId: string,
  client: IncusClientPort,
  signal: AbortSignal,
): Promise<void> {
  const rows = await deps.store.listScanContainers(serverId);
  const known = new Set(
    rows
      .filter((row) => row.lifecycle_phase !== 'deleting')
      .map((row) => normalized(row.id)),
  );
  const instances = await client.listInstances(2, { signal });
  const documents = instances.metadata as InstanceFull[];
  const byContainerId = indexManagedInstances(documents, serverId);
  for (const desired of rows) {
    if (desired.needs_attention || desired.lifecycle_phase === 'failed') continue;
    if (desired.lifecycle_phase === 'deleting') {
      await deps.store.enqueueScanIntent(desired, 'container.delete');
      continue;
    }
    const expectedName = deriveInstanceName(desired.id);
    const actual = byContainerId.get(normalized(desired.id));
    const usage = bytes(actual?.document.state?.disk?.root?.usage);
    if (usage !== null) {
      await deps.store.recordRootUsage(desired.id, usage);
    }
    if (await scanNeedsUpdate(deps, desired, expectedName, actual)) {
      await deps.store.enqueueScanIntent(desired, 'container.update');
    }
  }
  for (const document of documents) {
    const instanceIdentity = managedContainerIdentity(document);
    if (
      !instanceIdentity.managed
      || instanceIdentity.serverId !== normalized(serverId)
      || known.has(instanceIdentity.containerId)
    ) {
      continue;
    }
    await deletePhysicalInstance(deps, client, document.name ?? '');
  }
}
