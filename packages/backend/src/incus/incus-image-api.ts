import { IncusError } from './incus-errors.js';
import type { IncusRequestOptions, IncusResponse, IncusSchema } from './incus-client-types.js';
import { appendQuery, encodeImageAliasName, encodeSegment } from './incus-request-util.js';
import { IncusStorageApi } from './incus-storage-api.js';

/** Image and image-alias endpoints. */
export class IncusImageApi extends IncusStorageApi {
  listImages(
    recursion: 0 | 1 = 1,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Image'>[]>> {
    return this.requestJson('GET', appendQuery('/1.0/images', { recursion }), options);
  }

  getImage(
    fingerprint: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Image'>>> {
    return this.requestJson(
      'GET',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      options,
    );
  }

  createImage(
    document: IncusSchema<'ImagesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('POST', '/1.0/images', { ...options, body: document });
  }

  updateImage(
    fingerprint: string,
    document: IncusSchema<'ImagePut'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'PUT',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      { ...options, body: document },
    );
  }

  deleteImage(fingerprint: string, options?: IncusRequestOptions): Promise<IncusResponse<unknown>> {
    return this.requestJson(
      'DELETE',
      `/1.0/images/${encodeSegment(fingerprint, 'image_fingerprint')}`,
      options,
    );
  }

  createImageAlias(
    document: IncusSchema<'ImageAliasesPost'>,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    return this.requestJson('POST', '/1.0/images/aliases', { ...options, body: document });
  }

  async deleteImageAlias(
    name: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<unknown>> {
    try {
      return await this.requestJson(
        'DELETE',
        `/1.0/images/aliases/${encodeImageAliasName(name)}`,
        options,
      );
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') {
        return {
          status: 404,
          headers: {},
          envelope: { type: 'sync', status: 'Success', status_code: 200, metadata: {} },
          metadata: {},
        };
      }
      throw error;
    }
  }
}
