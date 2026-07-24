import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { SshIdentityService } from './ssh-identity.service.js';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation retained the database lease')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function pair(label: string) {
  return {
    privateKey: `private-${label}`,
    publicKey: `public-${label}`,
    fingerprint: `fingerprint-${label}`,
  };
}

describe('SshIdentityService external key generation boundaries', () => {
  let dataSource: DataSource;
  let service: SshIdentityService;
  let generateEd25519: ReturnType<typeof vi.fn>;
  let audit: { log: ReturnType<typeof vi.fn> };
  let sequence: number;

  beforeEach(async () => {
    sequence = 0;
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [UserEntity, UserInternalSshKeyEntity, SshProxyHostKeyEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(UserEntity).save({
      id: 'user-a',
      numericId: 1001,
      username: 'alice',
      passwordHash: 'hash',
      displayName: 'Alice',
      status: UserStatus.Active,
    });
    await dataSource.getRepository(UserInternalSshKeyEntity).save({
      userId: 'user-a',
      encryptedPrivateKey: 'enc:private-user-1',
      publicKey: 'public-user-1',
      fingerprint: 'fingerprint-user-1',
      generation: 1,
      rotatedAt: new Date(1),
    });
    generateEd25519 = vi.fn(async (comment: string) => {
      sequence += 1;
      const generation = Number(comment.split(':').at(-1)) || 1;
      return pair(`${generation}-${sequence}`);
    });
    audit = { log: vi.fn().mockResolvedValue(undefined) };
    const crypto = {
      encrypt: vi.fn((value: string) => `enc:${value}`),
      decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
    };
    service = new SshIdentityService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(UserInternalSshKeyEntity),
      dataSource.getRepository(SshProxyHostKeyEntity),
      { generateEd25519 } as never,
      crypto as never,
      audit as never,
      dataSource,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('releases the global database lease while a user rotation waits for ssh-keygen', async () => {
    const started = deferred();
    const release = deferred();
    generateEd25519.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return pair('user-2');
    });

    const rotation = service.rotateUserKey('user-a', 'admin-a', async () => undefined);
    await started.promise;
    try {
      await expect(settleWithin(runSerializedTransaction(dataSource, (manager) =>
        manager.count(UserEntity)))).resolves.toBe(1);
    } finally {
      release.resolve();
    }
    await expect(rotation).resolves.toMatchObject({ generation: 2 });
  });

  it('allows exactly one concurrent user-key rotation CAS winner', async () => {
    const bothStarted = deferred();
    const release = deferred();
    let started = 0;
    generateEd25519.mockImplementation(async () => {
      started += 1;
      const invocation = started;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return pair(`user-2-${invocation}`);
    });

    const rotations = Promise.allSettled([
      service.rotateUserKey('user-a', 'admin-a', async () => undefined),
      service.rotateUserKey('user-a', 'admin-b', async () => undefined),
    ]);
    await bothStarted.promise;
    release.resolve();
    const settled = await rotations;

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(ConflictException);
    const stored = await dataSource.getRepository(UserInternalSshKeyEntity).findOneByOrFail({
      userId: 'user-a',
    });
    expect(stored.generation).toBe(2);
    const winner = settled.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<SshIdentityService['rotateUserKey']>>> =>
        result.status === 'fulfilled',
    )!.value;
    expect(winner.privateKey).toBe(stored.encryptedPrivateKey.replace(/^enc:/, ''));
    expect(winner.publicKey).toBe(stored.publicKey);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('rechecks user-key rotation authority after generation and commits nothing when revoked', async () => {
    const started = deferred();
    const release = deferred();
    let authorized = true;
    let checks = 0;
    generateEd25519.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return pair('user-2');
    });
    const authorize = vi.fn(async () => {
      checks += 1;
      if (!authorized) throw new ForbiddenException('authority revoked');
    });

    const rotation = service.rotateUserKey('user-a', 'admin-a', authorize);
    await started.promise;
    authorized = false;
    release.resolve();

    await expect(rotation).rejects.toThrow('authority revoked');
    expect(checks).toBe(2);
    await expect(dataSource.getRepository(UserInternalSshKeyEntity).findOneByOrFail({
      userId: 'user-a',
    })).resolves.toMatchObject({ generation: 1, publicKey: 'public-user-1' });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('cannot resurrect an internal key when deletion wins during external generation', async () => {
    const started = deferred();
    const release = deferred();
    generateEd25519.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return pair('user-2');
    });

    const rotation = service.rotateUserKey('user-a', 'admin-a', async () => undefined);
    await started.promise;
    await runSerializedTransaction(dataSource, async (manager) => {
      await manager.update(UserEntity, 'user-a', { status: UserStatus.Deleting });
      await manager.delete(UserInternalSshKeyEntity, { userId: 'user-a' });
    });
    release.resolve();

    await expect(rotation).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'USER_DELETING' }),
    });
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).count()).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([UserStatus.Deleting, UserStatus.Deleted])(
    'never returns private or public internal key material for a %s user',
    async (status) => {
      await dataSource.getRepository(UserEntity).update('user-a', { status });

      await expect(service.getUserKeyDto(
        'user-a',
        'admin-a',
        true,
        async () => undefined,
      )).rejects.toBeDefined();
      await expect(service.getUserInternalPublicKey('user-a')).rejects.toBeDefined();
      await expect(runSerializedTransaction(dataSource, (manager) =>
        service.getUserInternalPublicKeyInTransaction(manager, 'user-a')))
        .rejects.toBeDefined();
      await expect(service.rotateUserKey('user-a', 'admin-a', async () => undefined))
        .rejects.toBeDefined();
      expect(generateEd25519).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    },
  );

  it('does not partially mutate a user key when external generation fails', async () => {
    generateEd25519.mockRejectedValueOnce(new Error('ssh-keygen unavailable'));

    await expect(service.rotateUserKey('user-a', 'admin-a', async () => undefined))
      .rejects.toThrow('ssh-keygen unavailable');
    await expect(dataSource.getRepository(UserInternalSshKeyEntity).findOneByOrFail({
      userId: 'user-a',
    })).resolves.toMatchObject({ generation: 1, publicKey: 'public-user-1' });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('does not report a committed user rotation as failed when post-commit audit fails', async () => {
    audit.log.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(service.rotateUserKey('user-a', 'admin-a', async () => undefined))
      .resolves.toMatchObject({ generation: 2 });
    await expect(dataSource.getRepository(UserInternalSshKeyEntity).findOneByOrFail({
      userId: 'user-a',
    })).resolves.toMatchObject({ generation: 2 });
  });

  it('releases the global database lease while initial host-key generation is stalled', async () => {
    const started = deferred();
    const release = deferred();
    generateEd25519.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return pair('host-1');
    });

    const ensure = service.ensureProxyHostKey();
    await started.promise;
    try {
      await expect(settleWithin(runSerializedTransaction(dataSource, (manager) =>
        manager.count(UserEntity)))).resolves.toBe(1);
    } finally {
      release.resolve();
    }
    await expect(ensure).resolves.toMatchObject({ generation: 1, privateKey: 'private-host-1' });
  });

  it('converges concurrent host-key ensure calls on one stored key and matching private key', async () => {
    const bothStarted = deferred();
    const release = deferred();
    let started = 0;
    generateEd25519.mockImplementation(async () => {
      started += 1;
      const invocation = started;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return pair(`host-1-${invocation}`);
    });

    const ensured = Promise.all([
      service.ensureProxyHostKey(),
      service.ensureProxyHostKey(),
    ]);
    await bothStarted.promise;
    release.resolve();
    const results = await ensured;
    const repository = dataSource.getRepository(SshProxyHostKeyEntity);
    const stored = await repository.findOneByOrFail({ id: 'singleton' });

    expect(await repository.count()).toBe(1);
    expect(results.map((result) => result.publicKey)).toEqual([stored.publicKey, stored.publicKey]);
    expect(results.map((result) => result.privateKey)).toEqual([
      stored.encryptedPrivateKey.replace(/^enc:/, ''),
      stored.encryptedPrivateKey.replace(/^enc:/, ''),
    ]);
    expect(new Set(results.map((result) => result.fingerprint))).toEqual(new Set([stored.fingerprint]));
  });

  it('reloads the committed host-key winner after a PostgreSQL serialization conflict', async () => {
    const stored = {
      id: 'singleton' as const,
      encryptedPrivateKey: 'enc:private-host-winner',
      publicKey: 'public-host-winner',
      fingerprint: 'fingerprint-host-winner',
      generation: 1,
      rotatedAt: new Date(1),
    };
    let transactionCall = 0;
    const fakeManager = {
      findOneBy: vi.fn(async () => transactionCall === 1 ? null : stored),
    };
    const fakeDataSource = {
      options: { type: 'postgres' },
      transaction: vi.fn(async (
        _isolation: string,
        work: (manager: typeof fakeManager) => Promise<unknown>,
      ) => {
        transactionCall += 1;
        if (transactionCall === 2) {
          throw Object.assign(new Error('could not serialize access'), { code: '40001' });
        }
        return work(fakeManager);
      }),
    };
    const postgresService = new SshIdentityService(
      {} as never,
      {} as never,
      { create: vi.fn((value) => value) } as never,
      { generateEd25519: vi.fn().mockResolvedValue(pair('host-loser')) } as never,
      {
        encrypt: vi.fn((value: string) => `enc:${value}`),
        decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
      } as never,
      audit as never,
      fakeDataSource as never,
    );

    await expect(postgresService.ensureProxyHostKey()).resolves.toMatchObject({
      publicKey: 'public-host-winner',
      privateKey: 'private-host-winner',
    });
    expect(fakeDataSource.transaction).toHaveBeenCalledTimes(3);
  });

  it('rechecks host-key ensure authority after generation and leaves no row when revoked', async () => {
    const started = deferred();
    const release = deferred();
    let authorized = true;
    const authorize = vi.fn(async () => {
      if (!authorized) throw new ForbiddenException('authority revoked');
    });
    generateEd25519.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return pair('host-1');
    });

    const ensure = service.ensureProxyHostKey(authorize);
    await started.promise;
    authorized = false;
    release.resolve();

    await expect(ensure).rejects.toThrow('authority revoked');
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(await dataSource.getRepository(SshProxyHostKeyEntity).count()).toBe(0);
  });

  it('allows exactly one concurrent host-key rotation CAS winner', async () => {
    await seedHostKey();
    const bothStarted = deferred();
    const release = deferred();
    let started = 0;
    generateEd25519.mockImplementation(async () => {
      started += 1;
      const invocation = started;
      if (started === 2) bothStarted.resolve();
      await release.promise;
      return pair(`host-2-${invocation}`);
    });

    const rotations = Promise.allSettled([
      service.rotateProxyHostKey(async () => undefined),
      service.rotateProxyHostKey(async () => undefined),
    ]);
    await bothStarted.promise;
    release.resolve();
    const settled = await rotations;

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await dataSource.getRepository(SshProxyHostKeyEntity).findOneByOrFail({
      id: 'singleton',
    });
    expect(stored.generation).toBe(2);
    const winner = settled.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<SshIdentityService['rotateProxyHostKey']>>> =>
        result.status === 'fulfilled',
    )!.value;
    expect(winner.publicKey).toBe(stored.publicKey);
    expect(winner.privateKey).toBe(stored.encryptedPrivateKey.replace(/^enc:/, ''));
  });

  it('rechecks host-key rotation authority after generation and preserves the prior key', async () => {
    await seedHostKey();
    const started = deferred();
    const release = deferred();
    let authorized = true;
    const authorize = vi.fn(async () => {
      if (!authorized) throw new ForbiddenException('authority revoked');
    });
    generateEd25519.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return pair('host-2');
    });

    const rotation = service.rotateProxyHostKey(authorize);
    await started.promise;
    await expect(settleWithin(runSerializedTransaction(dataSource, (manager) =>
      manager.count(UserEntity)))).resolves.toBe(1);
    authorized = false;
    release.resolve();

    await expect(rotation).rejects.toThrow('authority revoked');
    expect(authorize).toHaveBeenCalledTimes(2);
    await expect(dataSource.getRepository(SshProxyHostKeyEntity).findOneByOrFail({
      id: 'singleton',
    })).resolves.toMatchObject({ generation: 1, publicKey: 'public-host-1' });
  });

  it('preserves the prior host key when external rotation generation fails', async () => {
    await seedHostKey();
    generateEd25519.mockRejectedValueOnce(new Error('ssh-keygen unavailable'));

    await expect(service.rotateProxyHostKey(async () => undefined))
      .rejects.toThrow('ssh-keygen unavailable');
    await expect(dataSource.getRepository(SshProxyHostKeyEntity).findOneByOrFail({
      id: 'singleton',
    })).resolves.toMatchObject({
      generation: 1,
      publicKey: 'public-host-1',
      encryptedPrivateKey: 'enc:private-host-1',
    });
  });

  it('leaves no host-key row when initial external generation fails', async () => {
    generateEd25519.mockRejectedValueOnce(new Error('ssh-keygen unavailable'));

    await expect(service.ensureProxyHostKey()).rejects.toThrow('ssh-keygen unavailable');
    expect(await dataSource.getRepository(SshProxyHostKeyEntity).count()).toBe(0);
  });

  async function seedHostKey(): Promise<void> {
    await dataSource.getRepository(SshProxyHostKeyEntity).save({
      id: 'singleton',
      encryptedPrivateKey: 'enc:private-host-1',
      publicKey: 'public-host-1',
      fingerprint: 'fingerprint-host-1',
      generation: 1,
      rotatedAt: new Date(1),
    });
  }
});
