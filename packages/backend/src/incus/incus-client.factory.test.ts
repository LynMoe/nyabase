import { describe, expect, it, vi } from 'vitest';
import { DatabaseIncusClientFactory } from './incus-client.factory.js';

function config() {
  const values: Record<string, unknown> = {
    'incus.caFile': '',
    'incus.caPem': 'self-signed-incus-server-certificate',
    'incus.requestTimeoutMs': 11_000,
    'incus.operationWaitTimeoutMs': 42_000,
    'ssh.keyEncryptionSecret': 'test-encryption-secret',
    'auth.jwtSecret': 'test-jwt-secret',
  };
  return {
    get: vi.fn((key: string) => values[key]),
    keyEncryptionSecret: vi.fn(() => values['ssh.keyEncryptionSecret'] as string),
  };
}

const SERVER_ID = '00000000-0000-4000-8000-000000000001';

function database(server: Record<string, unknown>) {
  return {
    selectFrom: vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        where: vi.fn(() => builder),
        executeTakeFirst: vi.fn(async () => (table === 'infra.servers' ? server : undefined)),
        execute: vi.fn(async () => []),
      };
      return builder;
    }),
  };
}

const identity = {
  certificatePem: 'client-certificate',
  privateKeyPem: 'client-key',
  fingerprint: 'aa'.repeat(32),
  notAfter: new Date('2036-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

function factory(server: Record<string, unknown>) {
  const identityService = { get: vi.fn(async () => identity) };
  return {
    identityService,
    factory: new DatabaseIncusClientFactory(
      database(server) as never,
      config() as never,
      identityService as never,
    ),
  };
}

describe('DatabaseIncusClientFactory', () => {
  const server = {
    id: SERVER_ID,
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: 'cc'.repeat(32),
  };

  it('reuses one client per server and presents the generated client identity', async () => {
    const { factory: instance, identityService } = factory(server);
    const first = await instance.get(SERVER_ID);
    expect(await instance.get(SERVER_ID)).toBe(first);
    expect(identityService.get).toHaveBeenCalledOnce();
  });

  it('builds a new client when the expected server fingerprint changes', async () => {
    const { factory: instance } = factory(server);
    const first = await instance.get(SERVER_ID);
    const repinned = await instance.get(SERVER_ID, { expectedFingerprint: 'dd'.repeat(32) });
    expect(repinned).not.toBe(first);
  });
});
