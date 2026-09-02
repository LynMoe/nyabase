import { describe, expect, it } from 'vitest';
import { isCurrentPrincipalAccessQuery } from './query-client.js';
import { queryKeys } from './query-keys.js';
import { frontendExtensionHost } from '../extensions/host.js';

describe('isCurrentPrincipalAccessQuery', () => {
  it.each([
    [queryKeys.meAccess, true],
    [queryKeys.servers.user, true],
    [queryKeys.containers.userList, true],
    [queryKeys.volumes.user, true],
    [queryKeys.containers.attachments('user', 'c1'), true],
    [queryKeys.containers.intents('user', 'c1'), true],
    [queryKeys.resourceIntentFailures('user', '/containers/c1/intents'), true],
    [queryKeys.volumes.intents('v1', false), true],
    [frontendExtensionHost.extensionDevicesKey('example-card', 's1', false), true],
    [queryKeys.httpProxy.bindings, true],
    [queryKeys.httpProxy.domainPools, true],
    [queryKeys.servers.admin, false],
    [queryKeys.httpProxy.adminBindings, false],
    [queryKeys.containers.attachments('admin', 'c1'), false],
    [frontendExtensionHost.extensionDevicesKey('example-card', 's1', true), false],
    [queryKeys.storageCapacity('s1'), false],
    [queryKeys.volumeForm.servers, false],
  ])('classifies %j as %s', (key, expected) => {
    expect(isCurrentPrincipalAccessQuery(key)).toBe(expected);
  });
});
