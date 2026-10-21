import { describe, expect, it } from 'vitest';
import { isCurrentPrincipalAccessQuery } from './query-client.js';
import { queryKeys } from './query-keys.js';

describe('isCurrentPrincipalAccessQuery', () => {
  it.each([
    [queryKeys.meAccess, true],
    [queryKeys.servers.user, true],
    [queryKeys.containers.userList, true],
    [queryKeys.volumes.user, true],
    [queryKeys.containers.attachments('mine', 'c1'), true],
    [queryKeys.containers.intents('mine', 'c1'), true],
    [queryKeys.resourceIntentFailures('/intents?resourceType=container&resourceId=c1', 20), true],
    [queryKeys.gpu.devices('s1', 'mine'), true],
    [queryKeys.servers.pools('s1', 'mine'), true],
    [queryKeys.httpProxy.bindings, true],
    [queryKeys.httpProxy.domainPools, true],
    [queryKeys.servers.admin, false],
    [queryKeys.httpProxy.adminBindings, false],
    [queryKeys.containers.attachments('all', 'c1'), false],
    [queryKeys.resourceIntentFailures('/intents?scope=all&resourceType=container&resourceId=c1', 20), false],
    [queryKeys.gpu.devices('s1', 'all'), false],
    [queryKeys.servers.pools('s1', 'all'), false],
    [queryKeys.storageCapacity('s1'), false],
    [queryKeys.volumeForm.servers, false],
  ])('classifies %j as %s', (key, expected) => {
    expect(isCurrentPrincipalAccessQuery(key)).toBe(expected);
  });
});
