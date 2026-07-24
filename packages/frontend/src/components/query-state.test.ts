import { describe, expect, it } from 'vitest';
import { ApiError } from '../lib/api.js';
import { queryErrorPresentation } from './query-state.js';

describe('queryErrorPresentation', () => {
  it('keeps 403, 404, and network failures distinct from successful empty state', () => {
    expect(queryErrorPresentation(new ApiError(403, 'FORBIDDEN', 'no'), '容器').kind).toBe('forbidden');
    expect(queryErrorPresentation(new ApiError(404, 'NOT_FOUND', 'gone'), '容器').kind).toBe('not-found');
    expect(queryErrorPresentation(new ApiError(0, 'NETWORK_ERROR', 'offline'), '容器').kind).toBe('network');
  });
});
