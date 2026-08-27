import { describe, expect, it, vi } from 'vitest';
import { ServerConnectIntentService } from './server-connect-intent.service.js';

describe('ServerConnectIntentService', () => {
  it('stores the secret in Redis before persisting only its reference', async () => {
    const createPending = vi.fn().mockResolvedValue({ id: 'intent-id' });
    const storeTrustToken = vi.fn().mockResolvedValue(
      '00000000-0000-4000-8000-000000000001',
    );
    const service = new ServerConnectIntentService(
      { createPending } as never,
      { storeTrustToken } as never,
    );

    await expect(service.create({
      serverId: '00000000-0000-4000-8000-000000000002',
      trustToken: 'one-time-secret',
      targetGeneration: 1,
    })).resolves.toEqual({ id: 'intent-id' });

    expect(storeTrustToken).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000002',
      'one-time-secret',
    );
    expect(createPending).toHaveBeenCalledWith({
      kind: 'server.connect',
      resourceType: 'server',
      resourceId: '00000000-0000-4000-8000-000000000002',
      serverId: '00000000-0000-4000-8000-000000000002',
      requestedBy: undefined,
      targetGeneration: 1,
      request: { trustTokenRef: '00000000-0000-4000-8000-000000000001' },
    });
    expect(JSON.stringify(createPending.mock.calls[0]?.[0])).not.toContain('one-time-secret');
  });
});
