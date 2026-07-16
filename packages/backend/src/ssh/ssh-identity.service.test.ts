import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UserStatus } from '@nyabase/common';
import { UserEntity } from '../entities/user.entity.js';
import { UserInternalSshKeyEntity } from '../entities/user-internal-ssh-key.entity.js';
import { SshProxyHostKeyEntity } from '../entities/ssh-proxy-host-key.entity.js';
import { SshIdentityService } from './ssh-identity.service.js';

describe('SshIdentityService durable rotation', () => {
  let dataSource: DataSource;
  let service: SshIdentityService;
  const audit = { log: vi.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    vi.clearAllMocks();
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
      encryptedPrivateKey: 'enc:private-1',
      publicKey: 'public-1',
      fingerprint: 'fingerprint-1',
      generation: 1,
      rotatedAt: new Date(1),
    });
    const keygen = {
      generateEd25519: vi.fn(async (comment: string) => {
        const generation = Number(comment.split(':').at(-1)) || 1;
        await Promise.resolve();
        return {
          privateKey: `private-${generation}`,
          publicKey: `public-${generation}`,
          fingerprint: `fingerprint-${generation}`,
        };
      }),
    };
    const crypto = {
      encrypt: vi.fn((value: string) => `enc:${value}`),
      decrypt: vi.fn((value: string) => value.replace(/^enc:/, '')),
    };
    service = new SshIdentityService(
      dataSource.getRepository(UserEntity),
      dataSource.getRepository(UserInternalSshKeyEntity),
      dataSource.getRepository(SshProxyHostKeyEntity),
      keygen as never,
      crypto as never,
      audit as never,
      dataSource,
    );
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('serializes concurrent rotations into unique monotonic generations', async () => {
    const rotated = await Promise.all([
      service.rotateUserKey('user-a', 'admin-a'),
      service.rotateUserKey('user-a', 'admin-b'),
    ]);

    expect(rotated.map((key) => key.generation).sort()).toEqual([2, 3]);
    expect(new Set(rotated.map((key) => `${key.generation}:${key.fingerprint}`)).size).toBe(2);
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).findOneByOrFail({
      userId: 'user-a',
    })).toMatchObject({
      generation: 3,
      publicKey: 'public-3',
      fingerprint: 'fingerprint-3',
      encryptedPrivateKey: 'enc:private-3',
    });
    expect(audit.log).toHaveBeenCalledTimes(2);
  });

  it('does not report a committed rotation as failed when post-commit audit fails', async () => {
    audit.log.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(service.rotateUserKey('user-a', 'admin-a')).resolves.toMatchObject({
      generation: 2,
      fingerprint: 'fingerprint-2',
    });
    expect(await dataSource.getRepository(UserInternalSshKeyEntity).findOneByOrFail({
      userId: 'user-a',
    })).toMatchObject({ generation: 2 });
  });
});
