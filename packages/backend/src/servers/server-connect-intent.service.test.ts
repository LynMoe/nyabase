import { describe, expect, it, vi } from 'vitest';
import { ServerConnectIntentService } from './server-intents.service.js';

describe('ServerConnectIntentService', () => {
  it('stores the secret in the ephemeral store before persisting only its reference', async () => {
    const createPending = vi.fn().mockResolvedValue({ id: 'intent-id' });
    const storeTrustToken = vi.fn().mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    );
    const service = new ServerConnectIntentService(
      { createPending } as never,
      { storeTrustToken } as never,
    );

    await expect(service.create({
      serverId: '00000000-0000-4000-8000-000000000002',
      trustToken: 'one-time-secret',
      targetRevision: 1,
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
      targetRevision: 1,
      request: { trustTokenRef: '00000000-0000-4000-8000-000000000001' },
    });
    expect(JSON.stringify(createPending.mock.calls[0]?.[0])).not.toContain('one-time-secret');
  });

  it('refuses to queue a connect intent whose reference is not persistable', async () => {
    const createPending = vi.fn();
    const service = new ServerConnectIntentService(
      { createPending } as never,
      { storeTrustToken: vi.fn().mockReturnValue('one-time-secret') } as never,
    );
    await expect(service.create({
      serverId: '00000000-0000-4000-8000-000000000002',
      trustToken: 'one-time-secret',
      targetRevision: 1,
    })).rejects.toThrow('persistable trust-token reference');
    expect(createPending).not.toHaveBeenCalled();
  });
});
