import { describe, expect, it } from 'vitest';
import busyResponse from './fixtures/busy-500.json';
import {
  IncusError,
  isAlreadyExistsError,
  isMissingCustomVolumeError,
  mapIncusApiFailure,
  mapIncusOperationFailure,
  matchBusyInstanceError,
} from './incus-errors.js';

describe('Incus error mapping', () => {
  it('requires the exact busy operation text', () => {
    expect(matchBusyInstanceError(busyResponse.error)).toEqual({ action: 'start' });
    expect(
      matchBusyInstanceError('Instance is busy running a "start" operation\n'),
    ).toBeUndefined();
    expect(matchBusyInstanceError('Instance is busy running a "start" task')).toBeUndefined();
  });

  it('maps HTTP and operation failures with structured bounded details', () => {
    expect(
      mapIncusApiFailure({
        status: 500,
        apiErrorCode: 500,
        errorText: busyResponse.error,
        operationId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toMatchObject({
      code: 'INSTANCE_BUSY',
      disposition: 'retry',
      details: {
        action: 'start',
      },
    });
    expect(
      mapIncusOperationFailure({
        operationId: '11111111-1111-4111-8111-111111111111',
        statusCode: 400,
        errorCode: 400,
        status: 'Failure',
        errorText: 'managed operation failure',
        details: { request: { field: 'size' } },
      }),
    ).toMatchObject({
      code: 'OPERATION_FAILED',
      disposition: 'managed_failure',
      details: {
        operationId: '11111111-1111-4111-8111-111111111111',
        statusCode: 400,
        errorCode: 400,
        status: 'Failure',
        error: 'managed operation failure',
        request: { field: 'size' },
      },
    });
  });

  it('classifies missing custom volume and already-exists without mapping all 400s to retry', () => {
    expect(isMissingCustomVolumeError(new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
      error: 'Failed to start device: Storage volume "nyv-abc" not found',
    }))).toBe(true);
    expect(isMissingCustomVolumeError(new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
      error: 'invalid config',
    }))).toBe(false);
    expect(isAlreadyExistsError(new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
      status: 400,
      error: 'Volume already exists',
    }))).toBe(true);
    expect(isAlreadyExistsError(new IncusError('INCUS_API_ERROR', 'managed_failure', {
      status: 409,
    }))).toBe(true);
  });
});
