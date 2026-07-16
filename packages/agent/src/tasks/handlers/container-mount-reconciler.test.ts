import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from '../../docker/docker-client.js';
import { ContainerMountMismatchError, ContainerMountReconciler } from './container-mount-reconciler.js';

const expected = [{
  sourceId: 'disk-a',
  resourceId: 'resource-a',
  sourceIdentity: 'local:xfs:uuid-a',
  hostPath: '/tmp',
  containerPath: '/workspace',
}];

function reconciler(mounts: Array<Record<string, unknown>>) {
  const docker = {
    inspectContainer: vi.fn().mockResolvedValue({ Mounts: mounts }),
  } as unknown as DockerClient;
  return new ContainerMountReconciler(docker);
}

describe('ContainerMountReconciler Docker-native bind verification', () => {
  it('accepts the exact immutable bind set', async () => {
    await expect(reconciler([{
      Type: 'bind', Source: '/tmp', Destination: '/workspace',
    }]).ensure('runtime-a', expected)).resolves.toEqual({
      current: [{ src: '/tmp', dst: '/workspace' }],
    });
  });

  it('rejects another directory on the same filesystem instead of comparing the device source', async () => {
    await expect(reconciler([{
      Type: 'bind', Source: '/data/other-user', Destination: '/workspace',
    }]).verify('runtime-a', expected)).rejects.toBeInstanceOf(ContainerMountMismatchError);
  });

  it('rejects an unexpected extra bind because runtime mounts are immutable', async () => {
    await expect(reconciler([
      { Type: 'bind', Source: '/tmp', Destination: '/workspace' },
      { Type: 'bind', Source: '/host/secret', Destination: '/secret' },
    ]).verify('runtime-a', expected)).rejects.toThrow('Unexpected bind mount at /secret');
  });
});
