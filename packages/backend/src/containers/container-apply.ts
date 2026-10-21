import {
  applyManagedFields,
  compareManagedFields,
  IncusError,
  isMissingCustomVolumeError,
  readAfterTimeout,
  requestAndWait,
  type DesiredInstanceSpec,
  type IncusClientPort,
  type ManagedInstanceDocument,
} from '../incus/index.js';
import type { ContainerReconcileDeps } from './container-reconcile-deps.js';
import { readRequired } from './container-instance-ops.js';
import {
  MANAGED_FIELD_OWNERSHIP,
  auditIncusMutate,
  bytes,
  decideRootShrink,
  running,
  type ActualInstance,
  type ContainerRow,
  type InstanceState,
} from './container-reconcile-support.js';
import type { ReconcileRunContext } from '../reconcile/managed-reconciler.js';

/**
 * Refuse a root-disk shrink that would lose data (or cannot be judged), and
 * revert the desired size so the container stops asking for it.
 */
export async function guardRootShrink(
  deps: ContainerReconcileDeps,
  row: ContainerRow,
  actual: ActualInstance,
  desired: DesiredInstanceSpec,
  state: InstanceState,
  usedBytes: bigint | null,
): Promise<void> {
  const actualRoot = bytes((actual.document.devices?.root as Record<string, unknown> | undefined)?.size);
  const desiredRoot = bytes((desired.devices?.root as Record<string, unknown> | undefined)?.size);
  if (actualRoot === null || desiredRoot === null) return;
  const decision = decideRootShrink({
    resizeFamily: row.root_resize_family,
    actualRootBytes: actualRoot,
    desiredRootBytes: desiredRoot,
    usedBytes,
    running: running(state),
  });
  if (decision === 'allow') return;
  const code = decision === 'requires_stop'
    ? 'ROOT_SHRINK_REQUIRES_STOP'
    : decision === 'usage_unknown'
      ? 'ROOT_USAGE_UNKNOWN'
      : 'ROOT_SHRINK_BELOW_USAGE';
  if (decision === 'usage_floor' || decision === 'usage_unknown') {
    await deps.store.revertImpossibleRootShrink(row.id, actualRoot, usedBytes, code);
  }
  throw new IncusError(code, 'managed_failure', {
    containerId: row.id,
    requestedBytes: desiredRoot.toString(),
    usedBytes: usedBytes?.toString() ?? null,
  });
}

/** PUT the managed fields onto the instance and wait until the comparator sees no difference. */
export async function putManagedFields(
  deps: ContainerReconcileDeps,
  context: ReconcileRunContext,
  expectedName: string,
  desired: DesiredInstanceSpec,
  hasAttachments: boolean,
): Promise<void> {
  await auditIncusMutate(deps.audit, context.intent, {
    method: 'PUT',
    path: `/1.0/instances/${expectedName}`,
    instanceName: expectedName,
  });
  const client: IncusClientPort | undefined = context.client;
  if (!client) {
    throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
  }
  try {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.readModifyWriteInstance(
          expectedName,
          (document) => {
            const merged = applyManagedFields(
              document as ManagedInstanceDocument,
              desired,
              MANAGED_FIELD_OWNERSHIP,
            );
            document.config = merged.config;
            document.devices = merged.devices;
            return document;
          },
          options,
        ),
      ),
      async () => {
        const after = await readRequired(client, expectedName);
        const afterDiff = compareManagedFields(after.document, desired, MANAGED_FIELD_OWNERSHIP);
        if (afterDiff.kind !== 'empty') {
          throw new Error('INSTANCE_UPDATE_NOT_CONFIRMED');
        }
        return undefined;
      },
    );
  } catch (error) {
    if (isMissingCustomVolumeError(error) && hasAttachments) {
      throw new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
        reason: 'put_toctou',
      });
    }
    throw error;
  }
}
