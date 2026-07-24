import { describe, expect, it } from 'vitest';
import {
  GpuGrantMode,
  MAX_AGENT_GPU_DEVICES,
  MAX_GROUP_PRIORITY,
  MAX_CONTAINER_MOUNTS,
  MAX_RESOURCE_BYTES,
  MAX_RESOURCE_CPU_MILLIS,
  zContainerCreateTaskPayload,
  zCreateApiTokenRequest,
  zCreateContainerRequest,
  zCreateDataDirRequest,
  zCreateGroupRequest,
  zCreateImageRequest,
  zCreateRemoteFsMountRequest,
  zExecSessionRequest,
  zLoginRequest,
  zPullImageRequest,
  zPatchSystemSettingsRequest,
  zSyncImageGrantServersRequest,
  zUpdateGroupRequest,
  zUpdateContainerMountsRequest,
  zUpdateImageRequest,
  zUpdateRemoteFsMountRequest,
  zUpdateServerRequest,
  zUpdateUserRequest,
  zUpsertServerGrantRequest,
  RemoteFsType,
} from '@nyabase/common';

describe('strict authentication request boundaries', () => {
  it('trims API-token names before validating their length', () => {
    expect(zCreateApiTokenRequest.parse({ name: '  workstation  ' })).toEqual({
      name: 'workstation',
    });
    expect(() => zCreateApiTokenRequest.parse({ name: '   ' })).toThrow();
  });

  it('rejects unknown and oversized login fields', () => {
    expect(() => zLoginRequest.parse({ username: 'user', password: 'secret', typo: true })).toThrow();
    expect(() => zLoginRequest.parse({ username: 'u'.repeat(65), password: 'secret' })).toThrow();
    expect(() => zLoginRequest.parse({ username: 'user', password: 'p'.repeat(1025) })).toThrow();
  });
});

describe('bounded mutation request shapes', () => {
  it('rejects unknown nested container and exec fields', () => {
    expect(() => zCreateContainerRequest.parse({
      serverId: 'server-a',
      imageId: 'image-a',
      name: 'work',
      dataDirs: [{
        sourceKind: 'local', sourceId: 'disk-a', dirName: 'data-a',
        containerPath: '/data', typo: true,
      }],
    })).toThrow();
    expect(() => zExecSessionRequest.parse({ tty: true, command: 'unexpected' })).toThrow();
    expect(() => zCreateDataDirRequest.parse({
      serverId: 'server-a', sourceKind: 'local', sourceId: 'disk-a', name: 'data-a', extra: true,
    })).toThrow();
    expect(() => zUpdateContainerMountsRequest.parse([{
      sourceKind: 'local', sourceId: 'disk-a', dirName: 'data-a',
      containerPath: '/data', typo: true,
    }])).toThrow();
  });

  it('keeps create and update mount boundaries identical and bounded', () => {
    const valid = {
      sourceKind: 'local' as const,
      sourceId: 'disk-a',
      dirName: 'data-a',
      containerPath: '/data',
    };
    expect(zUpdateContainerMountsRequest.parse([valid])).toEqual([valid]);
    expect(() => zUpdateContainerMountsRequest.parse(
      Array.from({ length: MAX_CONTAINER_MOUNTS + 1 }, () => valid),
    )).toThrow();
    for (const invalid of [
      { ...valid, sourceId: '' },
      { ...valid, sourceId: 'x'.repeat(129) },
      { ...valid, containerPath: '/' },
      { ...valid, containerPath: '//' },
      { ...valid, containerPath: '///' },
      { ...valid, containerPath: '/../secret' },
      { ...valid, containerPath: '/data/./nested' },
      { ...valid, containerPath: '/data\nother' },
    ]) {
      expect(() => zUpdateContainerMountsRequest.parse([invalid])).toThrow();
      expect(() => zCreateContainerRequest.parse({
        serverId: 'server-a', imageId: 'image-a', name: 'work', dataDirs: [invalid],
      })).toThrow();
    }
  });

  it('bounds image runtime arguments and explicit pull targets', () => {
    expect(() => zCreateImageRequest.parse({
      name: 'oversized',
      dockerImage: 'alpine:latest',
      runtimeOverrides: {
        uid: 0,
        entrypoint: Array.from({ length: 257 }, () => 'arg'),
        cmd: null,
        init: false,
      },
    })).toThrow();
    expect(() => zPullImageRequest.parse({ serverIds: [] })).toThrow();
    expect(() => zPullImageRequest.parse({ serverIds: ['server-a', 'server-a'] })).toThrow();
    expect(zPullImageRequest.parse({})).toEqual({});
  });

  it('bounds RemoteFS assignment and image-grant replacement sets', () => {
    expect(() => zCreateRemoteFsMountRequest.parse({
      name: 'remote-a',
      serverIds: ['server-a', 'server-b'],
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'nfs.example',
        exportPath: '/data',
        version: '4.2',
      },
    })).toThrow();
    expect(() => zSyncImageGrantServersRequest.parse({
      serverIds: ['server-a', 'server-a'],
    })).toThrow();
  });

  it('rejects RemoteFS dot segments including the first path segment', () => {
    for (const exportPath of ['/./dataset', '/../secret', '/data/../secret', '/data/./nested']) {
      expect(() => zCreateRemoteFsMountRequest.parse({
        name: 'remote-a',
        params: {
          type: RemoteFsType.Nfs,
          nfsServer: 'nfs.example',
          exportPath,
          version: '4.2',
        },
      })).toThrow();
    }
  });

  it('rejects empty or semantically empty mutation requests', () => {
    for (const schema of [
      zUpdateServerRequest,
      zUpdateImageRequest,
      zUpdateRemoteFsMountRequest,
      zUpdateGroupRequest,
      zUpsertServerGrantRequest,
    ]) {
      expect(() => schema.parse({})).toThrow();
    }
    expect(() => zUpdateUserRequest.parse({ currentPassword: 'old-password' })).toThrow();
    const snapshotToken = 'a'.repeat(64);
    expect(() => zPatchSystemSettingsRequest.parse({
      expectedRevision: 1, expectedSnapshotToken: snapshotToken, values: {},
    })).toThrow();
    expect(() => zPatchSystemSettingsRequest.parse({ values: { 'branding.title': 'Lab' } })).toThrow();
    expect(zPatchSystemSettingsRequest.parse({
      expectedRevision: 1,
      expectedSnapshotToken: snapshotToken,
      values: { 'branding.title': 'Lab' },
    })).toEqual({
      expectedRevision: 1,
      expectedSnapshotToken: snapshotToken,
      values: { 'branding.title': 'Lab' },
    });
    expect(() => zPatchSystemSettingsRequest.parse({
      expectedRevision: 1,
      expectedSnapshotToken: 'not-opaque',
      values: { 'branding.title': 'Lab' },
    })).toThrow();
  });

  it('represents explicit RemoteFS metadata clearing without dropping the fields', () => {
    expect(zUpdateRemoteFsMountRequest.parse({
      displayName: null,
      description: null,
    })).toEqual({ displayName: null, description: null });
  });

  it('represents explicit group-description clearing without treating it as omission', () => {
    expect(zUpdateGroupRequest.parse({ description: null })).toEqual({ description: null });
  });
});

describe('resource-grant integer and GPU invariants', () => {
  it('accepts exact safe maxima and preserves zero group priority', () => {
    expect(zCreateGroupRequest.parse({ name: 'zero', priority: 0 }).priority).toBe(0);
    expect(zCreateGroupRequest.parse({ name: 'max', priority: MAX_GROUP_PRIORITY }).priority)
      .toBe(MAX_GROUP_PRIORITY);
    expect(zUpsertServerGrantRequest.parse({
      cpuMillis: MAX_RESOURCE_CPU_MILLIS,
      memBytes: MAX_RESOURCE_BYTES,
      diskBytes: MAX_RESOURCE_BYTES,
      gpuMode: GpuGrantMode.None,
      gpuIndices: [],
    })).toMatchObject({
      cpuMillis: MAX_RESOURCE_CPU_MILLIS,
      memBytes: MAX_RESOURCE_BYTES,
      diskBytes: MAX_RESOURCE_BYTES,
      gpuMode: GpuGrantMode.None,
      gpuIndices: [],
    });
  });

  it('rejects unsafe, non-finite, fractional, and Docker-overflowing values', () => {
    for (const body of [
      { cpuMillis: MAX_RESOURCE_CPU_MILLIS + 1 },
      { memBytes: MAX_RESOURCE_BYTES + 1 },
      { diskBytes: Number.POSITIVE_INFINITY },
      { cpuMillis: 1.5 },
    ]) {
      expect(() => zUpsertServerGrantRequest.parse(body)).toThrow();
    }
    expect(() => zCreateGroupRequest.parse({ name: 'fraction', priority: 0.5 })).toThrow();
    expect(() => zCreateGroupRequest.parse({
      name: 'unsafe',
      priority: MAX_GROUP_PRIORITY + 1,
    })).toThrow();
  });

  it('requires coherent, unique, bounded GPU selections', () => {
    expect(zUpsertServerGrantRequest.parse({
      gpuMode: GpuGrantMode.Indices,
      gpuIndices: [0, MAX_AGENT_GPU_DEVICES - 1],
    }).gpuIndices).toEqual([0, MAX_AGENT_GPU_DEVICES - 1]);

    for (const body of [
      { gpuMode: GpuGrantMode.Indices, gpuIndices: [] },
      { gpuMode: GpuGrantMode.Indices, gpuIndices: [0, 0] },
      { gpuMode: GpuGrantMode.Indices, gpuIndices: [MAX_AGENT_GPU_DEVICES] },
      { gpuMode: GpuGrantMode.None, gpuIndices: [0] },
      { gpuMode: GpuGrantMode.All, gpuIndices: [0] },
      { gpuMode: GpuGrantMode.None },
      { gpuIndices: [] },
    ]) {
      expect(() => zUpsertServerGrantRequest.parse(body)).toThrow();
    }
  });

  it('applies the same resource bounds to Agent task payloads', () => {
    const base = {
      containerId: 'container-a',
      specGeneration: 1,
      quotaGeneration: 1,
      dockerRoot: '/var/lib/nyabase-docker',
      ownerId: 'user-a',
      numericOwnerId: 1001,
      imageDockerRef: 'busybox:latest',
      imageDockerId: 'sha256:image-a',
      imageId: 'image-a',
      assignedIp: '10.0.0.2',
      name: 'container-a',
      cpuMillis: MAX_RESOURCE_CPU_MILLIS,
      memBytes: MAX_RESOURCE_BYTES,
      diskBytes: MAX_RESOURCE_BYTES,
      gpuIndices: [0],
    };
    expect(zContainerCreateTaskPayload.parse(base)).toMatchObject(base);
    expect(() => zContainerCreateTaskPayload.parse({
      ...base,
      cpuMillis: MAX_RESOURCE_CPU_MILLIS + 1,
    })).toThrow();
    expect(() => zContainerCreateTaskPayload.parse({
      ...base,
      gpuIndices: [0, 0],
    })).toThrow();
  });
});
