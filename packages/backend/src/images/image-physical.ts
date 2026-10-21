import {
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
} from '../incus/index.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import type { ImageReconcileDeps } from './image-reconcile-deps.js';
import {
  ImagePullNotConfirmedError,
  auditIncusMutate,
  imageFingerprint,
  imageHasAlias,
  isNotFound,
  sameFingerprint,
  selectImageForAssignment,
  type Image,
  type ImageAssignmentSource,
} from './image-reconcile-support.js';

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

/** Delete a managed image from the server. */
export async function deleteManagedImage(
  deps: ImageReconcileDeps,
  client: IncusClientPort,
  fingerprint: string,
  intent: IntentRecord,
): Promise<void> {
  await auditIncusMutate(deps.audit, intent, {
    method: 'DELETE',
    path: `/1.0/images/${fingerprint}`,
    instanceName: fingerprint,
  });
  await deleteImageConfirmed(client, fingerprint);
  await assertImageGone(client, fingerprint);
}

/** Point the alias at the fingerprint, replacing any other target. */
export async function ensureAliasOnFingerprint(
  deps: ImageReconcileDeps,
  client: IncusClientPort,
  images: readonly Image[],
  alias: string,
  fingerprint: string,
  intent: IntentRecord,
): Promise<void> {
  const target = images.find((image) => sameFingerprint(imageFingerprint(image), fingerprint));
  if (target && imageHasAlias(target, alias)) return;
  await auditIncusMutate(deps.audit, intent, {
    method: 'DELETE',
    path: `/1.0/images/aliases/${alias}`,
    instanceName: fingerprint,
  });
  await client.deleteImageAlias(alias);
  await auditIncusMutate(deps.audit, intent, {
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

/** Remove the superseded image; true when something still uses it and it must stay. */
export async function deletePreviousImageIfUnused(
  deps: ImageReconcileDeps,
  client: IncusClientPort,
  previous: string | null,
  desiredFingerprint: string,
  intent: IntentRecord,
): Promise<boolean> {
  if (!previous || sameFingerprint(previous, desiredFingerprint)) return false;
  let image: Image | undefined;
  try {
    image = (await client.getImage(previous)).metadata;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  if (imageUsedBy(image).length > 0) return true;
  await auditIncusMutate(deps.audit, intent, {
    method: 'DELETE',
    path: `/1.0/images/${previous}`,
    instanceName: previous,
  });
  await deleteImageConfirmed(client, previous);
  return false;
}

/**
 * Pull the image from the source server, sharing one pull between concurrent
 * intents for the same image (`pulls` is the reconciler's in-flight map).
 */
export async function ensurePulled(
  deps: ImageReconcileDeps,
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
    await auditIncusMutate(deps.audit, intent, {
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
