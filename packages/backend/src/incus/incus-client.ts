import { IncusError } from './incus-errors.js';
import type {
  IncusClientPort,
  IncusOperationWaitOptions,
  IncusRequestOptions,
  IncusResponse,
  IncusSchema,
} from './incus-client-types.js';
import { IncusImageApi } from './incus-image-api.js';
import { appendQuery, boundedTimeout, cloneRecord, encodeSegment } from './incus-request-util.js';

export * from './incus-client-types.js';
export {
  assertLeafCertificateFingerprint,
  encodeImageAliasName,
  isOperationWaitNotFound,
  leafCertificateFingerprint,
  operationIdFromEnvelope,
  readAfterTimeout,
} from './incus-request-util.js';

/**
 * The Incus REST client. Endpoints are grouped by API area in a layered chain
 * (transport, server/network, instances, storage, images); this class adds
 * operations and the etag-guarded instance update.
 */
export class IncusClient extends IncusImageApi implements IncusClientPort {
  getOperationWait(
    operationId: string,
    options: IncusOperationWaitOptions = {},
  ): Promise<IncusResponse<IncusSchema<'Operation'>>> {
    const timeoutMs = boundedTimeout(options.timeoutMs, this.operationWaitTimeoutMs);
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    return this.requestJson(
      'GET',
      appendQuery(`/1.0/operations/${encodeSegment(operationId, 'operation_id')}/wait`, {
        timeout: timeoutSeconds,
      }),
      { signal: options.signal, timeoutMs },
    );
  }

  getOperation(
    operationId: string,
    options?: IncusRequestOptions,
  ): Promise<IncusResponse<IncusSchema<'Operation'>>> {
    return this.requestJson(
      'GET',
      `/1.0/operations/${encodeSegment(operationId, 'operation_id')}`,
      options,
    );
  }

  async readModifyWriteInstance<T>(
    name: string,
    mutate: (document: IncusSchema<'InstancePut'>) => T | IncusSchema<'InstancePut'>,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<T | unknown>> {
    const actual = await this.getInstanceFull(name, { signal: options.signal });
    if (!actual.etag) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'missing_etag',
      });
    }

    const document: IncusSchema<'InstancePut'> = {
      architecture: actual.metadata.architecture,
      config: cloneRecord(actual.metadata.config),
      description: actual.metadata.description,
      devices: cloneRecord(actual.metadata.devices),
      ephemeral: actual.metadata.ephemeral,
      profiles: [],
      stateful: actual.metadata.stateful,
    };
    const mutationResult = mutate(document);
    const nextDocument =
      mutationResult && typeof mutationResult === 'object' && !Array.isArray(mutationResult)
        ? (mutationResult as IncusSchema<'InstancePut'>)
        : document;
    nextDocument.profiles = [];
    const response = await this.updateInstance(name, nextDocument, {
      ...options,
      ifMatch: actual.etag,
    });
    return response as IncusResponse<T | unknown>;
  }
}
