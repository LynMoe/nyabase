import { IntentKind, IntentResourceType } from '@nyabase/common';
import type {
  CreatePendingIntentInput,
  EnsurePendingIntentInput,
  IntentExecutor,
  IntentRecord,
  IntentRepository,
} from '../reconcile/intent.repository.js';

/**
 * Volume intents run against one Incus server: a local volume's own server, or
 * a registered placement of a shared volume. destroy is the exception and is
 * not bound to a server. Anything else is rejected before it is queued.
 */
export async function assertVolumeIntentTarget(
  input: Pick<CreatePendingIntentInput, 'kind' | 'resourceId' | 'serverId'>,
  executor: IntentExecutor,
): Promise<void> {
  if (input.kind === IntentKind.VolumeDestroy) {
    if (input.serverId) throw new Error('Volume destroy intents cannot carry a server id');
    return;
  }
  if (!input.serverId) throw new Error('Volume intents require a server id');
  const volume = await executor
    .selectFrom('control.volumes')
    .select(['server_id', 'shared_backend_id'])
    .where('id', '=', input.resourceId)
    .executeTakeFirst();
  if (volume?.shared_backend_id && input.kind === IntentKind.VolumeEnsure) {
    throw new Error('Shared volumes cannot enqueue volume.ensure');
  }
  if (volume && !volume.shared_backend_id && input.serverId !== volume.server_id) {
    throw new Error('Local volume intent server does not match the volume');
  }
  if (volume?.shared_backend_id) {
    const placement = await executor
      .selectFrom('control.volume_placements')
      .select('server_id')
      .where('volume_id', '=', input.resourceId)
      .where('server_id', '=', input.serverId)
      .executeTakeFirst();
    if (!placement) {
      throw new Error('Shared volume intent server does not match a placement');
    }
  }
}

export async function createVolumeIntent(
  intents: Pick<IntentRepository, 'createPending'>,
  input: CreatePendingIntentInput,
  executor: IntentExecutor,
): Promise<IntentRecord> {
  if (input.resourceType === IntentResourceType.Volume) {
    await assertVolumeIntentTarget(input, executor);
  }
  return intents.createPending(input, executor);
}

export async function ensureVolumeIntent(
  intents: Pick<IntentRepository, 'ensurePending'>,
  input: EnsurePendingIntentInput,
  executor: IntentExecutor,
): Promise<IntentRecord> {
  await assertVolumeIntentTarget(input, executor);
  return intents.ensurePending(input);
}
