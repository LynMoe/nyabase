import { describe, expect, it } from 'vitest';
import operationAccepted from './fixtures/operation-accepted.json';
import operationBusy from './fixtures/operation-busy.json';
import operationFailure from './fixtures/operation-failure.json';
import operationSuccess from './fixtures/operation-success.json';
import type { IncusEnvelope, IncusResponse } from './incus-client.js';
import { isAsyncIncusResponse, requestAndWait, waitForIncusOperation } from './incus-operation.js';

function response(payload: unknown, status = 200): IncusResponse<unknown> {
  const envelope = payload as IncusEnvelope<unknown>;
  return {
    status,
    headers: {},
    envelope,
    metadata: envelope.metadata,
  };
}

describe('Incus operation wait helper', () => {
  it('waits on the operation URL from a 202 envelope and checks completion metadata', async () => {
    const accepted = response(operationAccepted, 202);
    const waitedIds: string[] = [];
    const client = {
      getOperationWait: async (operationId: string): Promise<IncusResponse<never>> => {
        waitedIds.push(operationId);
        return response(operationSuccess) as IncusResponse<never>;
      },
    };

    expect(isAsyncIncusResponse(accepted)).toBe(true);
    const result = await waitForIncusOperation(client, accepted);
    expect(waitedIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(result).toMatchObject({
      kind: 'completed',
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'Success',
      statusCode: 200,
    });
  });

  it('maps asynchronous operation errors even when the wait HTTP status is 200', async () => {
    const accepted = response(operationAccepted, 202);
    const client = {
      getOperationWait: async (): Promise<IncusResponse<never>> =>
        response(operationFailure) as IncusResponse<never>,
    };
    await expect(waitForIncusOperation(client, accepted)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      disposition: 'retry',
      details: {
        operationId: '11111111-1111-4111-8111-111111111111',
        statusCode: 500,
        errorCode: 500,
        error: 'failed to resize filesystem',
      },
    });
  });

  it('treats Incus wait type=error envelopes with null metadata as managed failures', async () => {
    const accepted = response(operationAccepted, 202);
    const client = {
      getOperationWait: async (): Promise<IncusResponse<never>> =>
        response({
          type: 'error',
          status: '',
          status_code: 0,
          operation: '',
          error_code: 500,
          error: 'Failed creating instance record: Invalid CPU limit syntax',
          metadata: null,
        }) as IncusResponse<never>,
    };
    await expect(waitForIncusOperation(client, accepted)).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      disposition: 'managed_failure',
      details: {
        operationId: '11111111-1111-4111-8111-111111111111',
        statusCode: 400,
        errorCode: 500,
        error: 'Failed creating instance record: Invalid CPU limit syntax',
      },
    });
  });

  it('maps busy operation errors by their exact text, independent of HTTP status', async () => {
    const accepted = response(operationAccepted, 202);
    const client = {
      getOperationWait: async (): Promise<IncusResponse<never>> =>
        response(operationBusy) as IncusResponse<never>,
    };
    await expect(waitForIncusOperation(client, accepted)).rejects.toMatchObject({
      code: 'INSTANCE_BUSY',
      disposition: 'retry',
      details: { action: 'stop' },
    });
  });

  it('leaves Incus certificate trust responses with an empty operation alone', async () => {
    const sync = response({
      type: 'sync',
      status: 'Success',
      status_code: 200,
      operation: '',
      error_code: 0,
      error: '',
      metadata: null,
    }, 201);
    let waited = false;
    const result = await requestAndWait(
      {
        getOperationWait: async (): Promise<IncusResponse<never>> => {
          waited = true;
          return response(operationSuccess) as IncusResponse<never>;
        },
      },
      async () => sync,
    );
    expect(result).toEqual({ kind: 'synchronous', response: sync });
    expect(waited).toBe(false);
  });

  it('does not retry a malformed asynchronous response without an operation path', async () => {
    const accepted = response({
      type: 'async',
      status: 'Operation created',
      status_code: 100,
      operation: '',
      error_code: 0,
      error: '',
      metadata: null,
    }, 202);
    let requestCount = 0;
    let waitCount = 0;
    const client = {
      getOperationWait: async (): Promise<IncusResponse<never>> => {
        waitCount += 1;
        return response(operationSuccess) as IncusResponse<never>;
      },
    };

    await expect(requestAndWait(
      client,
      async () => {
        requestCount += 1;
        return accepted;
      },
    )).rejects.toMatchObject({
      code: 'INCUS_INVALID_RESPONSE',
      disposition: 'managed_failure',
      details: { reason: 'missing_operation' },
    });
    expect(requestCount).toBe(1);
    expect(waitCount).toBe(0);
  });

  it('passes the bounded cancellation context to the initial request and wait', async () => {
    const accepted = response(operationAccepted, 202);
    const controller = new AbortController();
    const observed: AbortSignal[] = [];
    const client = {
      getOperationWait: async (
        _operationId: string,
        options?: { signal?: AbortSignal },
      ): Promise<IncusResponse<never>> => {
        if (options?.signal) observed.push(options.signal);
        return response(operationSuccess) as IncusResponse<never>;
      },
    };
    const result = await requestAndWait(
      client,
      (options) => {
        if (options?.signal) observed.push(options.signal);
        return Promise.resolve(accepted);
      },
      { signal: controller.signal, timeoutMs: 1_000 },
    );
    expect(result.kind).toBe('completed');
    expect(observed).toEqual([controller.signal, controller.signal]);
  });
});
