import { IncusError, type IncusClientPort } from '../incus/index.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type { ReconcileOutcome, ReconcileRunContext } from '../reconcile/managed-reconciler.js';
import { deleteManagedImage, imageUsedBy } from './image-physical.js';
import type { ImageReconcileDeps } from './image-reconcile-deps.js';
import {
  canDeleteManagedImage,
  imageFailure,
  imageFingerprint,
  sameFingerprint,
  type AssignmentRow,
  type Image,
} from './image-reconcile-support.js';

const CLEANUP_RETRY_MS = 5_000;

/**
 * Remove an assignment: delete the managed image from the server unless
 * something else still holds or uses it, then drop the assignment row.
 */
export async function reconcileDeletion(
  deps: ImageReconcileDeps,
  client: IncusClientPort,
  assignment: AssignmentRow,
  images: readonly Image[],
  selected: Image | undefined,
  intent: IntentRecord,
): Promise<ReconcileOutcome> {
  const { store } = deps;
  const done = (): ReconcileOutcome => ({
    outcome: 'succeeded',
    observedRevision: assignment.revision,
  });
  const managed = assignment.managed_fingerprint;
  if (!managed) {
    await store.markAssignmentDeleted(assignment, !selected);
    return done();
  }
  if (selected && !sameFingerprint(imageFingerprint(selected), managed)) {
    const managedImage = images.find((candidate) => sameFingerprint(
      imageFingerprint(candidate),
      managed,
    ));
    if (!managedImage) {
      await store.markAssignmentDeleted(assignment, true);
      return done();
    }
    if (imageUsedBy(managedImage).length > 0) {
      return {
        outcome: 'failed',
        failure: imageFailure(
          'IMAGE_IN_USE',
          'Stop and delete instances still using the managed image fingerprint',
          { managedFingerprint: managed, observedFingerprint: imageFingerprint(selected) },
        ),
      };
    }
  }
  const image = images.find((candidate) => sameFingerprint(imageFingerprint(candidate), managed));
  if (!image) {
    await store.markAssignmentDeleted(assignment, true);
    return done();
  }
  const otherAssignment = await store.findOtherAssignmentHolding(assignment, managed);
  const pinned = await store.findContainerPinnedTo(assignment.server_id, managed);
  if (!canDeleteManagedImage({
    managedFingerprint: managed,
    actualFingerprint: imageFingerprint(image),
    otherAssignment: Boolean(otherAssignment),
    pinned: Boolean(pinned),
    usedBy: imageUsedBy(image).length > 0,
  })) {
    await store.markAssignmentDeleted(assignment, false);
    return done();
  }
  await deleteManagedImage(deps, client, managed, intent);
  await store.bumpCleanupGeneration(assignment.image_id);
  await store.markAssignmentDeleted(assignment, true);
  return done();
}

/**
 * Remove an inactive image no server holds any more: refuse while assignments
 * or containers remain, delete the physical copy on the cleanup owner, then drop the row.
 */
export async function reconcileImageCleanup(
  deps: ImageReconcileDeps,
  context: ReconcileRunContext,
): Promise<ReconcileOutcome> {
  const { store } = deps;
  const image = await store.readImage(context.intent.resourceId);
  if (!image) {
    return {
      outcome: 'succeeded',
      observedRevision: context.intent.targetRevision,
    };
  }
  if (
    context.intent.request?.operation !== 'cleanup_image'
    || image.is_active
    || !image.deleting
  ) {
    return {
      outcome: 'failed',
      failure: imageFailure(
        'IMAGE_ASSIGNMENT_NOT_FOUND',
        'The image assignment no longer exists',
      ),
    };
  }
  const assignments = await store.listAssignmentIdsOfImage(image.id);
  if (assignments.length > 0) {
    return {
      outcome: 'retry',
      retryAfterMs: CLEANUP_RETRY_MS,
      failure: imageFailure(
        'IMAGE_CLEANUP_ASSIGNMENTS_PRESENT',
        'The image still has server assignments to clean up',
        { assignmentCount: assignments.length },
      ),
    };
  }
  const retainedContainer = await store.findContainerOfImage(image.id);
  if (retainedContainer) {
    return {
      outcome: 'retry',
      retryAfterMs: CLEANUP_RETRY_MS,
      failure: imageFailure(
        'IMAGE_CLEANUP_CONTAINER_PRESENT',
        'The inactive image is still referenced by a container',
        { containerId: retainedContainer.id },
      ),
    };
  }
  if (!context.client) {
    throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
  }
  if (image.fingerprint) {
    const blocked = await deletePhysicalCopy(deps, context, context.client, image.fingerprint);
    if (blocked) return blocked;
  }
  await store.deleteInactiveImage(image.id);
  return {
    outcome: 'succeeded',
    observedRevision: context.intent.targetRevision,
  };
}

/** Delete the server's copy of an inactive image; returns a retry outcome while Incus still uses it. */
async function deletePhysicalCopy(
  deps: ImageReconcileDeps,
  context: ReconcileRunContext,
  client: IncusClientPort,
  fingerprint: string,
): Promise<ReconcileOutcome | null> {
  const images = (await client.listImages(1, { signal: context.signal })).metadata;
  const physical = images.find((candidate) =>
    sameFingerprint(imageFingerprint(candidate), fingerprint));
  if (!physical) return null;
  const usedBy = imageUsedBy(physical);
  if (usedBy.length > 0) {
    return {
      outcome: 'retry',
      retryAfterMs: CLEANUP_RETRY_MS,
      failure: imageFailure(
        'IMAGE_CLEANUP_BLOCKED',
        'The inactive image is still used by an Incus resource',
        { fingerprint, usedBy },
      ),
    };
  }
  await deleteManagedImage(deps, client, fingerprint, context.intent);
  return null;
}
