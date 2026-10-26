import { AuditAction } from '@nyabase/common';
import {
  IncusError,
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import type { AuditService } from '../iam/audit.service.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';

export type Image = IncusSchema<'Image'>;

export interface ImageAssignmentSource {
  readonly alias: string;
  readonly fingerprint: string | null;
  readonly sourceServer: string;
  readonly imageType?: string;
}

export async function auditIncusMutate(
  audit: AuditService,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

export class ImagePullNotConfirmedError extends Error {
  readonly code: 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH' | 'IMAGE_NOT_AVAILABLE';
  readonly details: Record<string, unknown>;

  constructor(desired: ImageAssignmentSource) {
    const pinned = desired.fingerprint !== null && desired.fingerprint !== undefined;
    super(
      pinned
        ? 'The pulled image did not have the pinned fingerprint'
        : 'The pulled image alias was not present after the pull',
    );
    this.name = 'ImagePullNotConfirmedError';
    this.code = pinned ? 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH' : 'IMAGE_NOT_AVAILABLE';
    this.details = pinned
      ? { desiredFingerprint: desired.fingerprint }
      : { alias: desired.alias };
  }
}
export function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export function imageFingerprint(image: Image | undefined): string | null {
  return image?.fingerprint ?? null;
}

export function imageHasAlias(image: Image, alias: string): boolean {
  return (image.aliases ?? []).some((item) => item.name === alias);
}

export function sameFingerprint(
  actual: string | null | undefined,
  desired: string | null | undefined,
): boolean {
  return actual !== null
    && actual !== undefined
    && desired !== null
    && desired !== undefined
    && actual.toLowerCase() === desired.toLowerCase();
}

export function selectImageForAssignment(
  images: readonly Image[],
  desired: Pick<ImageAssignmentSource, 'alias' | 'fingerprint'>,
): Image | undefined {
  if (desired.fingerprint !== null && desired.fingerprint !== undefined) {
    return images.find((image) => sameFingerprint(imageFingerprint(image), desired.fingerprint));
  }
  return images.find((image) => imageHasAlias(image, desired.alias));
}

export function canDeleteManagedImage(input: {
  readonly managedFingerprint: string | null;
  readonly actualFingerprint: string | null;
  readonly otherAssignment: boolean;
  readonly pinned: boolean;
  readonly usedBy: boolean;
}): boolean {
  return Boolean(
    input.managedFingerprint
    && sameFingerprint(input.actualFingerprint, input.managedFingerprint)
    && !input.otherAssignment
    && !input.pinned
    && !input.usedBy,
  );
}

/** Fingerprints of the Incus resources using the image. */
export function imageUsedBy(image: Image): string[] {
  return (image as Image & { used_by?: string[] }).used_by ?? [];
}

/** DELETE the image on the server and wait until a GET says it is gone. */
async function deleteImageConfirmed(client: IncusClientPort, fingerprint: string): Promise<void> {
  await readAfterTimeout(
    () => requestAndWait(client, (options) => client.deleteImage(fingerprint, options)),
    async () => {
      try {
        await client.getImage(fingerprint);
      } catch (error) {
        if (isNotFound(error)) return undefined;
        throw error;
      }
      throw new Error('IMAGE_DELETE_NOT_CONFIRMED');
    },
  );
}

/** After a delete, a final read must find the image missing (anything else but 404 is an error). */
async function assertImageGone(client: IncusClientPort, fingerprint: string): Promise<void> {
  try {
    await client.getImage(fingerprint);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/** Delete an image copy and confirm it is gone (the caller audits). */
export async function deleteImageCopy(client: IncusClientPort, fingerprint: string): Promise<void> {
  await deleteImageConfirmed(client, fingerprint);
  await assertImageGone(client, fingerprint);
}

/** Delete a managed image from the server. */
export async function deleteManagedImage(
  audit: AuditService,
  client: IncusClientPort,
  fingerprint: string,
  intent: IntentRecord,
): Promise<void> {
  await auditIncusMutate(audit, intent, {
    method: 'DELETE',
    path: `/1.0/images/${fingerprint}`,
    instanceName: fingerprint,
  });
  await deleteImageCopy(client, fingerprint);
}

/** Point the alias at the fingerprint, replacing any other target. */
export async function ensureAliasOnFingerprint(
  audit: AuditService,
  client: IncusClientPort,
  images: readonly Image[],
  alias: string,
  fingerprint: string,
  intent: IntentRecord,
): Promise<void> {
  const target = images.find((image) => sameFingerprint(imageFingerprint(image), fingerprint));
  if (target && imageHasAlias(target, alias)) return;
  await auditIncusMutate(audit, intent, {
    method: 'DELETE',
    path: `/1.0/images/aliases/${alias}`,
    instanceName: fingerprint,
  });
  await client.deleteImageAlias(alias);
  await auditIncusMutate(audit, intent, {
    method: 'POST',
    path: '/1.0/images/aliases',
    instanceName: fingerprint,
  });
  await client.createImageAlias({
    name: alias,
    target: fingerprint,
    type: 'container',
  });
}

/**
 * Pull the image from the source server, sharing one pull between concurrent
 * intents for the same image (`pulls` is the reconciler's in-flight map).
 */
export async function ensurePulled(
  audit: AuditService,
  pulls: Map<string, Promise<void>>,
  client: IncusClientPort,
  desired: ImageAssignmentSource,
  serverId: string,
  intent: IntentRecord,
): Promise<void> {
  const key = `${serverId}|${desired.sourceServer}|${desired.alias}|${desired.fingerprint ?? ''}|${desired.imageType ?? 'container'}`;
  const existing = pulls.get(key);
  if (existing) {
    await existing;
    return;
  }
  const pull: Promise<void> = (async () => {
    await auditIncusMutate(audit, intent, {
      method: 'POST',
      path: '/1.0/images',
      instanceName: desired.fingerprint ?? desired.alias,
    });
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.createImage(
          {
            aliases: [],
            source: {
              type: 'image',
              alias: desired.alias,
              fingerprint: desired.fingerprint ?? undefined,
              protocol: 'simplestreams',
              server: desired.sourceServer,
              image_type: desired.imageType ?? 'container',
            },
          },
          options,
        ),
      ),
      async () => {
        const retryImages = (await client.listImages(1)).metadata;
        const retryImage = selectImageForAssignment(retryImages, desired);
        if (
          !retryImage
          || (
            desired.fingerprint !== null
            && desired.fingerprint !== undefined
            && !sameFingerprint(imageFingerprint(retryImage), desired.fingerprint)
          )
        ) {
          throw new ImagePullNotConfirmedError(desired);
        }
        return undefined;
      },
    );
  })();
  pulls.set(key, pull);
  try {
    await pull;
  } finally {
    pulls.delete(key);
  }
}
