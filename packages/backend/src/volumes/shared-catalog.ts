import {
  IncusError,
  isAlreadyExistsError,
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
} from '../incus/index.js';

export type SharedCatalogEnsureResult = 'present' | 'posted' | 'missing';

function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export async function ensureSharedCatalogOnServer(
  client: IncusClientPort,
  input: {
    poolName: string;
    incusName: string;
    sizeBytes: string | number;
  },
): Promise<SharedCatalogEnsureResult> {
  try {
    await client.getStorageVolume(input.poolName, 'custom', input.incusName);
    return 'present';
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await readAfterTimeout(
      () => requestAndWait(
        client,
        (options) => client.createStorageVolume(
          input.poolName,
          {
            name: input.incusName,
            type: 'custom',
            content_type: 'filesystem',
            config: {
              size: String(input.sizeBytes),
              'security.shifted': 'true',
            },
          },
          options,
        ),
      ),
      async () => {
        await client.getStorageVolume(input.poolName, 'custom', input.incusName);
        return undefined;
      },
    );
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  try {
    await client.getStorageVolume(input.poolName, 'custom', input.incusName);
    return 'posted';
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return 'missing';
  }
}
