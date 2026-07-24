import { Capability, UserStatus } from '@nyabase/common';
import { DataSource } from 'typeorm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupEntity } from '../entities/group.entity.js';
import { GroupMemberEntity } from '../entities/group-member.entity.js';
import { UserEntity } from '../entities/user.entity.js';
import { runSerializedTransaction } from '../database/serialized-transaction.js';
import { AccessCacheEpochService } from './access-cache-epoch.service.js';
import { AccessResolverService } from './access-resolver.service.js';

describe('AccessResolverService external work admission', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [UserEntity, GroupEntity, GroupMemberEntity],
    });
    await dataSource.initialize();
    await dataSource.getRepository(UserEntity).save({
      id: 'actor-a',
      numericId: 1001,
      username: 'alice',
      passwordHash: 'unused',
      displayName: 'Alice',
      status: UserStatus.Active,
      authVersion: 0,
    });
    await dataSource.getRepository(GroupEntity).save({
      id: 'operators',
      name: 'Operators',
      description: null,
      priority: 1,
      isSystem: false,
      systemKey: null,
      capabilitiesJson: JSON.stringify([Capability.ManageServers]),
    } as GroupEntity);
    await dataSource.getRepository(GroupMemberEntity).save({
      id: 'membership-a', groupId: 'operators', userId: 'actor-a',
    });
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('releases the global SQLite coordinator before a remote acknowledgement settles', async () => {
    let finish!: (value: string) => void;
    const remote = new Promise<string>((resolve) => { finish = resolve; });
    const resolver = new AccessResolverService(
      dataSource.getRepository(GroupEntity),
      dataSource.getRepository(GroupMemberEntity),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new AccessCacheEpochService(),
    );

    const started = await resolver.startExternalWithActorCapabilities(
      'actor-a',
      [Capability.ManageServers],
      () => remote,
    );

    await expect(runSerializedTransaction(dataSource, async (manager) => {
      await manager.update(UserEntity, 'actor-a', { displayName: 'Updated' });
      return 'database-reused';
    })).resolves.toBe('database-reused');
    finish('remote-finished');
    await expect(started.completion).resolves.toBe('remote-finished');
  });

  it('does not dispatch when a queued revocation commits before admission', async () => {
    const resolver = new AccessResolverService(
      dataSource.getRepository(GroupEntity),
      dataSource.getRepository(GroupMemberEntity),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new AccessCacheEpochService(),
    );
    let releaseRevocation!: () => void;
    const revocationBlocked = new Promise<void>((resolve) => { releaseRevocation = resolve; });
    let revocationStarted!: () => void;
    const revocationEntered = new Promise<void>((resolve) => { revocationStarted = resolve; });
    const revoke = runSerializedTransaction(dataSource, async (manager) => {
      revocationStarted();
      await revocationBlocked;
      await manager.delete(GroupMemberEntity, { userId: 'actor-a', groupId: 'operators' });
    });
    await revocationEntered;
    const start = vi.fn(async () => 'should-not-start');

    const admission = resolver.startExternalWithActorCapabilities(
      'actor-a',
      [Capability.ManageServers],
      start,
    );
    releaseRevocation();
    await revoke;
    await expect(admission).rejects.toThrow('cannot grant or administer');
    expect(start).not.toHaveBeenCalled();
  });
});
