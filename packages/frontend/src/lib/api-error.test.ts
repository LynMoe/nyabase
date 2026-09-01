import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorCurrent, errorMessage } from './api-error.js';

describe('ApiError conflict envelope', () => {
  const isSnapshot = (value: unknown): value is { revision: number; name: string } => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return Number.isSafeInteger(candidate.revision) && typeof candidate.name === 'string';
  };

  it('returns only a validated current snapshot for the expected conflict code', () => {
    const current = { revision: 2, name: 'remote' };
    const error = new ApiError(409, 'REVISION_CONFLICT', 'conflict', { current });
    expect(apiErrorCurrent(error, 'REVISION_CONFLICT', isSnapshot)).toBe(current);
    expect(apiErrorCurrent(error, 'OTHER', isSnapshot)).toBeNull();
  });

  it('fails closed for malformed or absent current response data', () => {
    expect(apiErrorCurrent(
      new ApiError(409, 'REVISION_CONFLICT', 'conflict', { current: { revision: '2' } }),
      'REVISION_CONFLICT',
      isSnapshot,
    )).toBeNull();
    expect(apiErrorCurrent(new ApiError(409, 'REVISION_CONFLICT', 'conflict'), 'REVISION_CONFLICT', isSnapshot))
      .toBeNull();
  });
});

describe('apiErrorDetails', () => {
  it('reads nested details from the error body', async () => {
    const { apiErrorDetails } = await import('./api-error.js');
    const error = new ApiError(409, 'SHARED_BACKEND_IDENTITY_CONFLICT', 'conflict', {
      details: { identityKey: 'cephfs:a', expectedFsid: 'aaa' },
    });
    expect(apiErrorDetails(error)).toEqual({ identityKey: 'cephfs:a', expectedFsid: 'aaa' });
    expect(apiErrorDetails(new Error('nope'))).toBeNull();
  });
});

describe('errorMessage', () => {
  it('returns Error.message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('uses the period-free fallback for non-Error values', () => {
    expect(errorMessage('not-an-error')).toBe('请稍后重试');
    expect(errorMessage(null)).toBe('请稍后重试');
  });

  it('accepts a custom fallback', () => {
    expect(errorMessage(undefined, '自定义兜底')).toBe('自定义兜底');
  });
});
