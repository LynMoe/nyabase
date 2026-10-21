import type { IncusRequestOptions, IncusResponse, IncusSchema } from './incus-client-types.js';
import { appendQuery, encodeSegment } from './incus-request-util.js';
import { IncusInstanceApi } from './incus-instance-api.js';

/** Storage pool and storage volume endpoints. */
export class IncusStorageApi extends IncusInstanceApi {
  listStoragePools(
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>[]>> {
    return this.requestJson('GET', appendQuery('/1.0/storage-pools', { recursion }), options);
  }

  getStoragePool(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StoragePool'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(name, 'storage_pool')}`,
      options,
    );
  }

  getStoragePoolResources(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'ResourcesStoragePool'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(name, 'storage_pool')}/resources`,
      options,
    );
  }

  listStorageVolumes(
    poolName: string,
    type = 'custom',
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'StorageVolume'>[]>> {
    // Incus filters by volume type via the path segment (/volumes/custom). A
    // `?type=` query is ignored and returns mixed types (including container
    // root volumes), which then 404 when probed as custom.
    return this.requestJson(
      'GET',
      appendQuery(
        `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
          type,
          'volume_type',
        )}`,
        { recursion },
      ),
      options,
    );
  }

  getStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolume'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}`,
      options,
    );
  }

  getStorageVolumeState(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'StorageVolumeState'>>> {
    return this.requestJson(
      'GET',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}/state`,
      options,
    );
  }

  createStorageVolume(
    poolName: string,
    document: IncusSchema<'StorageVolumesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'POST',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes`,
      { ...options, body: document },
    );
  }

  updateStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    document: IncusSchema<'StorageVolumePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'PUT',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}`,
      { ...options, body: document },
    );
  }

  deleteStorageVolume(
    poolName: string,
    type: string,
    volumeName: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'DELETE',
      `/1.0/storage-pools/${encodeSegment(poolName, 'storage_pool')}/volumes/${encodeSegment(
        type,
        'volume_type',
      )}/${encodeSegment(volumeName, 'volume_name')}`,
      options,
    );
  }
}
