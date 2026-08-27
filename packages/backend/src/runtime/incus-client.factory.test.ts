import { describe, expect, it, vi } from 'vitest';
import { encryptPrivateKey } from '../incus/incus-credentials.js';
import { DatabaseIncusClientFactory } from './incus-client.factory.js';

function config() {
  const values: Record<string, unknown> = {
    'incus.caFile': '',
    'incus.caPem': 'self-signed-incus-server-certificate',
    'incus.clientCertificateFile': '',
    'incus.clientCertificatePem': '',
    'incus.clientPrivateKeyFile': '',
    'incus.clientPrivateKeyPem': '',
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

function database() {
  let activeIndex = 0;
  const active = [
    {
      id: '00000000-0000-4000-8000-000000000010',
      generation: '1',
      certificate_pem: 'client-certificate-one',
      encrypted_private_key: encryptPrivateKey('client-key-one', 'test-encryption-secret'),
      fingerprint: 'aa'.repeat(32),
      not_before: new Date('2026-01-01T00:00:00Z'),
      not_after: new Date('2027-01-01T00:00:00Z'),
      state: 'active',
      created_by: null,
      created_at: new Date('2026-01-01T00:00:00Z'),
      activated_at: new Date('2026-01-01T00:00:00Z'),
      retired_at: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000011',
      generation: '2',
      certificate_pem: 'client-certificate-two',
      encrypted_private_key: encryptPrivateKey('client-key-two', 'test-encryption-secret'),
      fingerprint: 'bb'.repeat(32),
      not_before: new Date('2026-02-01T00:00:00Z'),
      not_after: new Date('2027-02-01T00:00:00Z'),
      state: 'active',
      created_by: null,
      created_at: new Date('2026-02-01T00:00:00Z'),
      activated_at: new Date('2026-02-01T00:00:00Z'),
      retired_at: null,
    },
  ];
  const server = {
    id: '00000000-0000-4000-8000-000000000001',
    api_endpoint: 'https://incus.example.test:8443',
    server_cert_fingerprint: 'cc'.repeat(32),
  };
  const database = {
    selectFrom: vi.fn((table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        selectAll: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        executeTakeFirst: vi.fn(async () => {
          if (table === 'infra.servers') return server;
          if (table === 'system.incus_client_certificates') return active[activeIndex];
          return undefined;
        }),
        execute: vi.fn(async () => []),
      };
      return builder;
    }),
  };
  return {
    database,
    advance: () => {
      activeIndex = 1;
    },
  };
}

describe('DatabaseIncusClientFactory', () => {
  it('reloads the active encrypted certificate after generation changes', async () => {
    const fixture = database();
    const factory = new DatabaseIncusClientFactory(
      fixture.database as never,
      config() as never,
    );

    const first = await factory.get('00000000-0000-4000-8000-000000000001');
    expect(await factory.get('00000000-0000-4000-8000-000000000001')).toBe(first);

    fixture.advance();
    const rotated = await factory.get('00000000-0000-4000-8000-000000000001');
    expect(rotated).not.toBe(first);
  });
});
