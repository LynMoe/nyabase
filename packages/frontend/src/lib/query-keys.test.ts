import { describe, expect, it } from 'vitest';
import { queryKeys } from './query-keys.js';

const GRANT_SLICES = ['servers', 'pools', 'backends', 'effective-access'] as const;

describe('queryKeys catalog', () => {
  it('keeps the four grant subjectList slices unequal by shape', () => {
    const keys = GRANT_SLICES.map((slice) => queryKeys.grants.subjectList('users', 'u1', slice));
    expect(new Set(keys.map((key) => JSON.stringify(key))).size).toBe(4);
    expect(keys[0]).toEqual(['grants', 'users', 'u1', 'servers']);
    expect(keys[1]).toEqual(['grants', 'users', 'u1', 'pools']);
    expect(keys[2]).toEqual(['grants', 'users', 'u1', 'backends']);
    expect(keys[3]).toEqual(['grants', 'users', 'u1', 'effective-access']);
  });

  it('treats grants.subject as the prefix of each subjectList slice', () => {
    const prefix = queryKeys.grants.subject('groups', 'g1');
    expect(prefix).toEqual(['grants', 'groups', 'g1']);
    for (const slice of GRANT_SLICES) {
      const key = queryKeys.grants.subjectList('groups', 'g1', slice);
      expect(key.slice(0, prefix.length)).toEqual(prefix);
      expect(key).not.toEqual(prefix);
    }
  });

  it('preserves existing tuple literals', () => {
    expect(queryKeys.servers.user).toEqual(['servers', 'user']);
    expect(queryKeys.servers.admin).toEqual(['servers', 'admin']);
    expect(queryKeys.containers.userList).toEqual(['containers', 'user']);
    expect(queryKeys.containers.adminList).toEqual(['containers', 'admin']);
    expect(queryKeys.volumes.user).toEqual(['volumes', 'user']);
    expect(queryKeys.volumes.admin).toEqual(['volumes', 'admin']);
    expect(queryKeys.volumes.adminByServer('s1')).toEqual(['volumes', 'admin', 's1']);
    expect(queryKeys.volumes.adminByServer('s1').slice(0, queryKeys.volumes.admin.length))
      .toEqual(queryKeys.volumes.admin);
    expect(queryKeys.sharedVolumes.all).toEqual(['shared-volumes']);
    expect(queryKeys.sharedVolumes.user).toEqual(['shared-volumes', 'user']);
    expect(queryKeys.sharedVolumes.admin).toEqual(['shared-volumes', 'admin']);
    expect(queryKeys.sharedVolumes.attachable('s1')).toEqual(['shared-volumes', 'attachable', 's1']);
    expect(queryKeys.sharedVolumes.catalogs('v1')).toEqual(['shared-volumes', 'catalogs', 'v1']);
    expect(queryKeys.sharedVolumes.attachable('s1').slice(0, queryKeys.sharedVolumes.all.length))
      .toEqual(queryKeys.sharedVolumes.all);
    expect(queryKeys.images.catalog).toEqual(['images', 'admin', 'catalog']);
    expect(queryKeys.images.userActive).toEqual(['images', 'user', 'active']);
    expect(queryKeys.images.detail('i1')).toEqual(['images', 'admin', 'i1']);
    expect(queryKeys.resourceIntentFailures('admin', '/admin/images/i1/intents', 20))
      .toEqual(['resource-intent-failures', 'admin', '/admin/images/i1/intents', 20]);
    expect(queryKeys.resourceIntentFailures('admin', '/admin/images/i1/intents', 50))
      .not.toEqual(queryKeys.resourceIntentFailures('admin', '/admin/images/i1/intents', 20));
    expect(queryKeys.users.admin).toEqual(['users', 'admin']);
    expect(queryKeys.users.detail('u1')).toEqual(['users', 'admin', 'u1']);
    expect(queryKeys.users.detail('u1').slice(0, queryKeys.users.admin.length))
      .toEqual(queryKeys.users.admin);
    expect(queryKeys.grants.subject('users', 'abc')).toEqual(['grants', 'users', 'abc']);
    expect(queryKeys.meAccess).toEqual(['me', 'access']);
    expect(queryKeys.publicSettings).toEqual(['public-settings']);
    expect(queryKeys.certificate).toEqual(['incus-client-certificate']);
    expect(queryKeys.systemSettings).toEqual(['system-settings']);
    expect(queryKeys.catalog.users).toEqual(['catalog', 'users']);
    expect(queryKeys.sshProxy.status).toEqual(['ssh-proxy-status']);
    expect(queryKeys.sshProxy.hostKey).toEqual(['ssh-proxy-host-key']);
    expect(queryKeys.sharedBackends.admin).toEqual(['shared-backends', 'admin']);
    expect(queryKeys.sharedBackends.detail('b1')).toEqual(['shared-backends', 'admin', 'b1']);
  });
});
