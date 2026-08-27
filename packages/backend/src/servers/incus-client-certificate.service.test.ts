import { describe, expect, it, vi } from 'vitest';
import { IncusClientCertificateService } from './incus-client-certificate.service.js';

const material = vi.hoisted(() => ({
  generate: vi.fn().mockResolvedValue({
    certificatePem: 'candidate-certificate',
    privateKeyPem: 'candidate-private-key',
  }),
  validate: vi.fn().mockReturnValue({
    fingerprint: 'aa'.repeat(32),
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2027-01-01T00:00:00Z'),
  }),
  encrypt: vi.fn().mockReturnValue('incus-v1.encrypted'),
}));

vi.mock('../incus/incus-credentials.js', () => ({
  generateIncusClientCertificate: material.generate,
  validateCertificateKeyPair: material.validate,
  encryptPrivateKey: material.encrypt,
}));

function chain<T>(value: T) {
  const builder: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['selectAll', 'select', 'where', 'forUpdate', 'orderBy', 'values', 'set']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.executeTakeFirst = vi.fn().mockResolvedValue(value);
  builder.executeTakeFirstOrThrow = vi.fn().mockResolvedValue(value);
  builder.execute = vi.fn().mockResolvedValue(Array.isArray(value) ? value : []);
  builder.returningAll = vi.fn(() => builder);
  return builder;
}

function certificate(generation = '1', state = 'active') {
  return {
    id: `00000000-0000-4000-8000-00000000000${generation}`,
    generation,
    certificate_pem: 'active-certificate',
    encrypted_private_key: 'active-key',
    fingerprint: 'bb'.repeat(32),
    not_before: new Date('2026-01-01T00:00:00Z'),
    not_after: new Date('2027-01-01T00:00:00Z'),
    state,
    created_by: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    activated_at: new Date('2026-01-01T00:00:00Z'),
    retired_at: null,
  };
}

describe('IncusClientCertificateService', () => {
  it('generates and persists a staged candidate with pending trust rows', async () => {
    const active = certificate();
    const candidate = certificate('2', 'staged');
    let certificateSelects = 0;
    const transaction = {
      selectFrom: vi.fn((table: string) => {
        if (table === 'system.incus_client_certificates') {
          certificateSelects += 1;
          return certificateSelects === 1
            ? chain(active)
            : chain({ max_generation: '1' });
        }
        return chain([{ id: 'server-1' }, { id: 'server-2' }]);
      }),
      updateTable: vi.fn(() => chain(undefined)),
      insertInto: vi.fn((table: string) => (
        table === 'system.incus_client_certificates'
          ? chain(candidate)
          : chain(undefined)
      )),
    };
    const database = {
      selectFrom: vi.fn((table: string) => (
        table === 'system.incus_client_certificate_trusts'
          ? chain([])
          : chain([])
      )),
    };
    const transactions = {
      run: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(transaction)),
    };
    const access = {
      assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const audit = { append: vi.fn().mockResolvedValue(undefined) };
    const intents = {
      createPending: vi.fn().mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000099',
        targetGeneration: 2,
      }),
    };
    const config = {
      get: vi.fn((key: string) => (
        key === 'ssh.keyEncryptionSecret' ? 'certificate-encryption-secret' : ''
      )),
      keyEncryptionSecret: vi.fn(() => 'certificate-encryption-secret'),
    };
    const service = new IncusClientCertificateService(
      database as never,
      transactions as never,
      access as never,
      audit as never,
      intents as never,
      config as never,
    );

    const result = await service.rotate(
      '00000000-0000-4000-8000-000000000010',
      1,
    );

    expect(material.generate).toHaveBeenCalledOnce();
    expect(material.encrypt).toHaveBeenCalledWith(
      'candidate-private-key',
      'certificate-encryption-secret',
    );
    expect(transaction.insertInto).toHaveBeenCalledWith(
      'system.incus_client_certificate_trusts',
    );
    expect(result.status).toBe('pending');
    expect(result.certificate.state).toBe('staged');
    expect(access.assertActorCapabilitiesInTransaction).toHaveBeenCalledOnce();
  });

  it('rotateAsSystem skips capability checks and no-ops when a staged cert exists', async () => {
    const active = certificate();
    let certificateSelects = 0;
    const transaction = {
      selectFrom: vi.fn((table: string) => {
        if (table === 'system.incus_client_certificates') {
          certificateSelects += 1;
          return certificateSelects === 1
            ? chain(active)
            : chain({ id: 'staged-id' });
        }
        return chain([]);
      }),
      updateTable: vi.fn(() => chain(undefined)),
      insertInto: vi.fn(() => chain(undefined)),
    };
    const access = {
      assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(undefined),
    };
    const service = new IncusClientCertificateService(
      { selectFrom: vi.fn(() => chain([])) } as never,
      { run: vi.fn(async (callback: (value: unknown) => Promise<unknown>) => callback(transaction)) } as never,
      access as never,
      { append: vi.fn() } as never,
      { createPending: vi.fn() } as never,
      { keyEncryptionSecret: vi.fn(() => 'certificate-encryption-secret') } as never,
    );

    await expect(
      service.rotateAsSystem('00000000-0000-4000-8000-000000000099'),
    ).resolves.toBeNull();
    expect(access.assertActorCapabilitiesInTransaction).not.toHaveBeenCalled();
    expect(transaction.insertInto).not.toHaveBeenCalled();
  });
});
