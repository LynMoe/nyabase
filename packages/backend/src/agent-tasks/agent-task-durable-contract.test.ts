import { AgentTaskKind, RemoteFsType } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import type { AgentTaskEntity } from '../entities/agent-task.entity.js';
import {
  AGENT_TASK_RESOURCE_TYPE_BY_KIND,
  agentTaskPayloadHash,
  parseAndValidateAgentTaskWireIdentity,
  validateDurableAgentTaskIdentity,
  validateDurableAgentTaskRowIdentity,
} from './agent-task-durable-contract.js';

const SERVER_ID = 'server-a';
const CONTAINER_ID = 'container-a';
const RUNTIME_ID = 'runtime-a';
const QUOTA_PATHS = [
  '/var/lib/nyabase-docker/overlay/upper',
  '/var/lib/nyabase-docker/overlay/work',
];

describe('durable Agent task identity contract', () => {
  const cases = durableCases();

  it.each(cases)('accepts the complete $kind identity row', ({ kind, resourceId, payload }) => {
    const task = durableTask(kind, resourceId, payload);
    expect(validateDurableAgentTaskIdentity(task, payload)).toEqual(
      parseAndValidateAgentTaskWireIdentity(task, payload),
    );
  });

  it.each(cases)('rejects wrong resourceType for $kind', ({ kind, resourceId, payload }) => {
    const task = durableTask(kind, resourceId, payload);
    task.resourceType = 'wrong-resource-type';
    expect(() => validateDurableAgentTaskIdentity(task, payload)).toThrow(/resourceType/);
  });

  it.each(cases)('rejects wrong row resourceType without reading the $kind payload', ({
    kind,
    resourceId,
    payload,
  }) => {
    const task = durableTask(kind, resourceId, payload);
    task.resourceType = 'wrong-resource-type';
    task.payloadJson = 'unreadable';
    expect(() => validateDurableAgentTaskRowIdentity(task)).toThrow(/resourceType/);
  });

  it.each([
    ['serverId', ''],
    ['serverId', 's'.repeat(129)],
    ['serverId', 'bad server'],
    ['resourceId', ''],
    ['resourceId', 'r'.repeat(129)],
    ['resourceId', 'bad resource'],
  ] as const)('rejects invalid durable row %s=%s', (field, value) => {
    const task = durableTask(AgentTaskKind.ImageEnsurePresent, 'image-a', {
      dockerRef: 'example.invalid/image:a',
    });
    task[field] = value;
    expect(() => validateDurableAgentTaskRowIdentity(task)).toThrow();
  });

  it('rejects an unknown durable row kind before reading its payload', () => {
    const task = durableTask(AgentTaskKind.ImageEnsurePresent, 'image-a', {
      dockerRef: 'example.invalid/image:a',
    });
    task.kind = 'unknown.kind' as AgentTaskKind;
    task.payloadJson = 'unreadable';
    expect(() => validateDurableAgentTaskRowIdentity(task)).toThrow(/unknown durable Agent task kind/);
  });

  it.each(cases.filter((entry) => entry.identityField !== null))(
    'rejects cross-resource payload identity for $kind',
    ({ kind, resourceId, payload, identityField }) => {
      const tampered = { ...payload, [identityField!]: `${resourceId}-other` };
      const task = durableTask(kind, resourceId, payload);
      task.payloadJson = tampered;
      task.payloadHash = agentTaskPayloadHash(kind, tampered);
      expect(() => validateDurableAgentTaskIdentity(task, tampered)).toThrow(/durable task identity/);
    },
  );

  it.each([
    AgentTaskKind.ContainerDelete,
    AgentTaskKind.ContainerRuntimeAbsent,
  ])('rejects cross-server payload identity for %s', (kind) => {
    const selected = cases.find((entry) => entry.kind === kind)!;
    const tampered = { ...selected.payload, serverId: 'server-other' };
    const task = durableTask(kind, selected.resourceId, selected.payload);
    task.payloadJson = tampered;
    task.payloadHash = agentTaskPayloadHash(kind, tampered);
    expect(() => validateDurableAgentTaskIdentity(task, tampered)).toThrow(/payload serverId/);
  });

  it('rejects an ordinary payload changed under its original hash', () => {
    const original = { dockerRef: 'example.invalid/original' };
    const task = durableTask(AgentTaskKind.ImageEnsurePresent, 'image-a', original);
    expect(() => validateDurableAgentTaskIdentity(
      task,
      { dockerRef: 'example.invalid/tampered' },
    )).toThrow(/payload hash/);
  });

  it('hashes the decoded RemoteFS wire secret rather than the stored ciphertext', () => {
    const wire = remotePayload('cGxhaW4tc2VjcmV0');
    const stored = remotePayload('Y2lwaGVydGV4dA==');
    const task = durableTask(AgentTaskKind.RemoteFsEnsure, 'remote-a', wire);
    expect(() => validateDurableAgentTaskIdentity(task, stored)).toThrow(/payload hash/);
    expect(validateDurableAgentTaskIdentity(task, wire)).toMatchObject({
      params: { secret: 'cGxhaW4tc2VjcmV0' },
    });
    expect(() => validateDurableAgentTaskIdentity(
      task,
      remotePayload('Y2hhbmdlZC1zZWNyZXQ='),
    )).toThrow(/payload hash/);
  });
});

function durableTask(
  kind: AgentTaskKind,
  resourceId: string,
  payload: Record<string, unknown>,
): AgentTaskEntity {
  const task = {
    id: 'task-a',
    kind,
    serverId: SERVER_ID,
    resourceType: AGENT_TASK_RESOURCE_TYPE_BY_KIND[kind],
    resourceId,
    payloadJson: payload,
    payloadHash: '',
  } as AgentTaskEntity;
  task.payloadHash = agentTaskPayloadHash(
    kind,
    parseAndValidateAgentTaskWireIdentity(task, payload),
  );
  return task;
}

function durableCases(): Array<{
  kind: AgentTaskKind;
  resourceId: string;
  payload: Record<string, unknown>;
  identityField: string | null;
}> {
  const create = {
    containerId: CONTAINER_ID,
    specGeneration: 1,
    quotaGeneration: 1,
    dockerRoot: '/var/lib/nyabase-docker',
    ownerId: 'user-a',
    numericOwnerId: 1001,
    imageDockerRef: 'example.invalid/image:a',
    imageDockerId: 'sha256:a',
    imageId: 'image-a',
    assignedIp: '10.0.0.2',
    name: 'container-a',
    cpuMillis: 1000,
    memBytes: 4096,
    diskBytes: 4096,
  };
  const start = {
    containerId: CONTAINER_ID,
    runtimeId: RUNTIME_ID,
    dockerRoot: '/var/lib/nyabase-docker',
    quotaGeneration: 1,
    numericOwnerId: 1001,
    diskBytes: 4096,
    quotaPaths: QUOTA_PATHS,
  };
  const stop = { containerId: CONTAINER_ID, runtimeId: RUNTIME_ID };
  return [
    { kind: AgentTaskKind.ContainerCreate, resourceId: CONTAINER_ID, payload: create, identityField: 'containerId' },
    { kind: AgentTaskKind.ContainerStart, resourceId: CONTAINER_ID, payload: start, identityField: 'containerId' },
    { kind: AgentTaskKind.ContainerStop, resourceId: CONTAINER_ID, payload: stop, identityField: 'containerId' },
    {
      kind: AgentTaskKind.ContainerRestart,
      resourceId: CONTAINER_ID,
      payload: { ...start, baselineStartedAt: '2026-07-19T00:00:00.000Z' },
      identityField: 'containerId',
    },
    {
      kind: AgentTaskKind.ContainerSshEnsure,
      resourceId: CONTAINER_ID,
      payload: { ...stop, enabled: false },
      identityField: 'containerId',
    },
    {
      kind: AgentTaskKind.ContainerDelete,
      resourceId: CONTAINER_ID,
      payload: {
        containerId: CONTAINER_ID,
        runtimeId: null,
        serverId: SERVER_ID,
        specGeneration: null,
        runtimeSpecHash: null,
        numericOwnerId: 1001,
        quotaPaths: [],
      },
      identityField: 'containerId',
    },
    {
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      resourceId: RUNTIME_ID,
      payload: {
        runtimeId: RUNTIME_ID,
        containerId: CONTAINER_ID,
        serverId: SERVER_ID,
        specGeneration: '1',
        runtimeSpecHash: 'a'.repeat(64),
        quotaPaths: QUOTA_PATHS,
        observedIp: '10.0.0.2',
      },
      identityField: 'runtimeId',
    },
    {
      kind: AgentTaskKind.DataDirEnsure,
      resourceId: 'datadir-a',
      payload: {
        resourceId: 'datadir-a', generation: 1, diskId: 'disk-a',
        sourceIdentity: 'local:xfs:disk-a', quotaRequired: true, uid: 1001,
        numericUserId: 1001, quotaGeneration: 1, diskBytes: 4096,
      },
      identityField: 'resourceId',
    },
    {
      kind: AgentTaskKind.DataDirAbsent,
      resourceId: 'datadir-a',
      payload: {
        resourceId: 'datadir-a', generation: 1, diskId: 'disk-a',
        sourceIdentity: 'local:xfs:disk-a', numericUserId: 1001,
      },
      identityField: 'resourceId',
    },
    { kind: AgentTaskKind.RemoteFsEnsure, resourceId: 'remote-a', payload: remotePayload(), identityField: 'id' },
    { kind: AgentTaskKind.RemoteFsAbsent, resourceId: 'remote-a', payload: remotePayload(), identityField: 'id' },
    {
      kind: AgentTaskKind.QuotaEnsure,
      resourceId: 'user-a',
      payload: { generation: 1, numericUserId: 1001, diskBytes: 4096 },
      identityField: null,
    },
    {
      kind: AgentTaskKind.ImageEnsurePresent,
      resourceId: 'image-a',
      payload: { imageId: 'image-a', dockerRef: 'example.invalid/image:a' },
      identityField: 'imageId',
    },
    {
      kind: AgentTaskKind.ImageEnsureAbsent,
      resourceId: 'image-a',
      payload: { imageId: 'image-a', dockerRef: 'example.invalid/image:a' },
      identityField: 'imageId',
    },
  ];
}

function remotePayload(secret?: string): Record<string, unknown> {
  if (secret !== undefined) {
    return {
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-fs/remote-a',
      options: '',
      params: {
        type: RemoteFsType.CephFs,
        monHosts: 'ceph.internal',
        exportPath: '/exports/a',
        clientName: 'nyabase',
        secret,
      },
    };
  }
  return {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    options: '',
    params: {
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.internal',
      exportPath: '/exports/a',
      version: '4',
    },
  };
}
