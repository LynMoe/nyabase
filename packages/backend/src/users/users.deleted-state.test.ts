import {
  MAX_AGENT_XFS_PROJECTS,
  MAX_PLATFORM_ACTIVE_USERS,
  UserStatus,
} from '@nyabase/common';
import { DataSource, type Repository } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccessResolverService } from '../access/access-resolver.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { SshPublicKeyEntity } from '../entities/ssh-public-key.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import type { ProxySnapshotNotifierService } from '../proxy-snapshots/proxy-snapshot-notifier.service.js';
import type { ContainerSshConvergenceService } from '../ssh/container-ssh-convergence.service.js';
import type { SshIdentityService } from '../ssh/ssh-identity.service.js';
import { UsersService } from './users.service.js';

describe('UsersService terminal deleted state', () => {
  let dataSource: DataSource;
  let service: UsersService;
  let invalidateUser: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let createUserKeyInTransaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [UserEntity],
    });
    await dataSource.initialize();
    invalidateUser = vi.fn();
    notify = vi.fn().mockResolvedValue(undefined);
    createUserKeyInTransaction = vi.fn().mockResolvedValue(undefined);
    service = new UsersService(
      dataSource.getRepository(UserEntity),
      {} as Repository<SshPublicKeyEntity>,
      { hashPassword: vi.fn().mockResolvedValue('hash') } as unknown as AuthService,
      { invalidateUser } as unknown as AccessResolverService,
      dataSource,
      {} as ContainerSshConvergenceService,
      { createUserKeyInTransaction } as unknown as SshIdentityService,
      { notify } as unknown as ProxySnapshotNotifierService,
      {} as NyabaseConfigService,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('never reactivates or mutates a deleted tombstone', async () => {
    await saveUser(UserStatus.Deleted);

    await expect(service.updateUser('user-a', {
      status: UserStatus.Active,
      displayName: 'Resurrected',
    })).rejects.toMatchObject({ response: expect.objectContaining({ code: 'USER_DELETED' }) });

    expect(await dataSource.getRepository(UserEntity).findOneByOrFail({ id: 'user-a' }))
      .toMatchObject({ status: UserStatus.Deleted, displayName: 'User A' });
    await expect(service.findById('user-a')).rejects.toMatchObject({ status: 404 });
    await expect(service.findAll()).resolves.toEqual([]);
    expect(invalidateUser).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps Disabled reversible and invalidates cached access on recovery', async () => {
    await saveUser(UserStatus.Disabled);

    await expect(service.updateUser('user-a', { status: UserStatus.Active }))
      .resolves.toMatchObject({ status: UserStatus.Active });
    expect(invalidateUser).toHaveBeenCalledWith('user-a');
    expect(notify).toHaveBeenCalledWith('user-updated');
  });

  it('serializes concurrent activation at the fixed active-user capacity', async () => {
    await dataSource.getRepository(UserEntity).save([
      ...Array.from({ length: MAX_PLATFORM_ACTIVE_USERS - 1 }, (_, index) => ({
        id: `active-${index}`,
        numericId: 2_000 + index,
        username: `active-${index}`,
        passwordHash: 'hash',
        displayName: `Active ${index}`,
        status: UserStatus.Active,
      })),
      {
        id: 'candidate-a', numericId: 4_000, username: 'candidate-a', passwordHash: 'hash',
        displayName: 'Candidate A', status: UserStatus.Disabled,
      },
      {
        id: 'candidate-b', numericId: 4_001, username: 'candidate-b', passwordHash: 'hash',
        displayName: 'Candidate B', status: UserStatus.Disabled,
      },
    ]);

    const results = await Promise.allSettled([
      service.updateUser('candidate-a', { status: UserStatus.Active }),
      service.updateUser('candidate-b', { status: UserStatus.Active }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await dataSource.getRepository(UserEntity).countBy({ status: UserStatus.Active }))
      .toBe(MAX_PLATFORM_ACTIVE_USERS);
  });

  it('rejects creation when deleted tombstones fill the XFS project inventory namespace', async () => {
    await seedDeletedUsers(MAX_AGENT_XFS_PROJECTS);

    await expect(service.createUser({
      username: 'overflow-user',
      password: 'secret',
      displayName: 'Overflow User',
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'USER_LIFETIME_CAPACITY_REACHED' }),
    });

    expect(await dataSource.getRepository(UserEntity).count()).toBe(MAX_AGENT_XFS_PROJECTS);
    expect(createUserKeyInTransaction).not.toHaveBeenCalled();
  });

  it('serializes concurrent creation at the lifetime user capacity', async () => {
    await seedDeletedUsers(MAX_AGENT_XFS_PROJECTS - 1);

    const results = await Promise.allSettled([
      service.createUser({ username: 'last-a', password: 'secret', displayName: 'Last A' }),
      service.createUser({ username: 'last-b', password: 'secret', displayName: 'Last B' }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      response: expect.objectContaining({ code: 'USER_LIFETIME_CAPACITY_REACHED' }),
    });
    expect(await dataSource.getRepository(UserEntity).count()).toBe(MAX_AGENT_XFS_PROJECTS);
    expect(createUserKeyInTransaction).toHaveBeenCalledOnce();
  });

  async function saveUser(status: UserStatus) {
    await dataSource.getRepository(UserEntity).save({
      id: 'user-a',
      numericId: 1001,
      username: 'user-a',
      passwordHash: 'hash',
      displayName: 'User A',
      status,
    });
  }

  async function seedDeletedUsers(count: number): Promise<void> {
    const repository = dataSource.getRepository(UserEntity);
    const batchSize = 512;
    for (let start = 0; start < count; start += batchSize) {
      const end = Math.min(count, start + batchSize);
      await repository.insert(Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset + 1;
        return {
          id: `deleted-${index}`,
          numericId: index,
          username: `deleted-${index}`,
          passwordHash: 'hash',
          displayName: `Deleted ${index}`,
          status: UserStatus.Deleted,
        };
      }));
    }
  }
});
