import { describe, it, expect } from 'vitest';
import {
  zEnvelope,
  zHelloPayload,
  zContainerSnapshot,
  zContainerRuntimeObservation,
  zContainerCreateTaskPayload,
  zContainerStartTaskPayload,
  zContainerStopTaskPayload,
  zTaskExecutePayload,
  zTaskResultPayload,
  zTaskAcceptedPayload,
  agentTaskPayloadSchemas,
  parseAgentTaskPayload,
  zStateReportPayload,
  zDiskInfo,
  zGpuInfo,
  zReconcilePayload,
  zInventoryFaultPayload,
  zInspectContainerResult,
  zSelfCheckResult,
  zSafeEpochMs,
  zMetricsBatchPayload,
  zAgentBootstrapPayload,
  zAgentBootstrapResult,
  zDataDirEnsureTaskPayload,
  zDataDirAbsentTaskPayload,
  zContainerSshEnsureTaskPayload,
  zRemoteFsParams,
  zRemoteFsAbsentTaskPayload,
  zCreateRemoteFsMountRequest,
  zUpdateRemoteFsMountRequest,
  zAddSshKeyRequest,
  zCreateImageRequest,
  zUpdateImageRequest,
  zUpdateAdminImageRequest,
  zUpdateAdminGroupRequest,
  zCreateContainerRequest,
  zLoginRequest,
  zCreateServerRequest,
  zUpdateUserRequest,
  zSshProxyDisconnectAllCommand,
  zSshProxyDisconnectAllResult,
  zSshProxySnapshot,
  zSshProxyStatusReport,
  zHttpProxySnapshot,
  zHttpProxyStatusReport,
  hostnameMatchesHttpProxyWildcard,
  normalizeHttpProxyHostname,
  normalizeHttpProxyWildcardDomain,
  resolveHttpProxyRoute,
  httpProxyWarningMessage,
  parseSshProxyLogin,
  resolveSshProxyRoute,
  ContainerStatus,
  UserStatus,
  AgentTaskKind,
  AgentTaskStatus,
  RuntimeDriftKind,
  RemoteFsType,
  LABEL,
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
  MAX_METRIC_LABELS_PER_POINT,
  MAX_METRIC_POINTS_PER_BATCH,
  MAX_AGENT_REMOTE_FS_MOUNTS,
  MAX_AGENT_GPU_DEVICES,
  MAX_HTTP_PROXY_ACTIVE_CONNECTIONS,
  MAX_SSH_PROXY_STATUS_CONNECTIONS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  ECMASCRIPT_DATE_MAX_EPOCH_MS,
  AGENT_PROTOCOL_MAX_FUTURE_CLOCK_SKEW_MS,
  type AgentTaskRefResponse,
  type AgentTaskDto,
  type UserAgentTaskDto,
} from '@nyabase/common';

declare const process: {
  cwd(): string;
};

declare const require: {
  (id: 'fs'): {
    readFileSync(path: string, encoding: 'utf8'): string;
  };
};

const { readFileSync } = require('fs');

const VALID_ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAFd/vaXN2I0jY5BiWgFdcK4lc66lU/wUQqmKHUgQzt3';
const PAYLOAD_HASH = 'a'.repeat(64);
const VALID_RSA_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDs8YEmsGdfwIVB5wvZrdRWPpE64x+g798tiQ9D4xvg7/1XjSAlSaRMTXdUgR5YSH35oMUqfLaLJvZcip7wXyfpgbV/jbC/izdM4KGZqqa+dpjPFkgqfJKSvzcfErHBu5l6oZlHQumhvxn1IGw+IA/P30hhN7Hrgp+YmIpotwZP5SrTsPg/hhOT5WkniMJt+ZL0fAyIqjv3LkX6U7oVjaaiiezAqOwMSPTUwVFYj5xLF5N82KqzkSVJodrx5Q7nUHXfBqUYNl+RnKLiZoUVlOqmF5Lk4sBa0+0OKoyBtO8T1vl8RRgFJy1R40yFIbLGNhfSqIVqg4OUkBQCO/RSTbO/ valid-rsa@example';
const VALID_ECDSA_NISTP256_KEY = 'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBCd/hpmwc75yKGwmVHTk7TPnhd96ExCFpRgzXxjvaj2HLATMkf6qJhO2MdocBs6D+FcImasH8iEFxo1fhkW7S5Q= valid-ecdsa@example';

function commonSrcPath(relativePath: string): string {
  const cwd = process.cwd();
  const commonRoot = cwd.endsWith('/packages/common') ? cwd : `${cwd}/packages/common`;
  return `${commonRoot}/src/${relativePath}`;
}

describe('zUpdateUserRequest', () => {
  it('allows reversible disable/enable but reserves the terminal deleted state for DELETE', () => {
    expect(zUpdateUserRequest.parse({ status: UserStatus.Disabled }))
      .toEqual({ status: UserStatus.Disabled });
    expect(zUpdateUserRequest.parse({ status: UserStatus.Active }))
      .toEqual({ status: UserStatus.Active });
    expect(() => zUpdateUserRequest.parse({ status: UserStatus.Deleted })).toThrow();
  });
});

describe('zUpdateAdminGroupRequest', () => {
  it('requires a positive CAS revision and at least one mutable group field', () => {
    expect(zUpdateAdminGroupRequest.parse({ expectedRevision: 2, description: null }))
      .toEqual({ expectedRevision: 2, description: null });
    expect(() => zUpdateAdminGroupRequest.parse({ description: 'missing revision' })).toThrow();
    expect(() => zUpdateAdminGroupRequest.parse({ expectedRevision: 2 })).toThrow();
  });
});

describe('zEnvelope', () => {
  it('accepts a minimal envelope', () => {
    expect(zEnvelope.parse({ ts: 1, kind: 'hello', payload: {} })).toMatchObject({
      ts: 1,
      kind: 'hello',
    });
  });

  it('rejects missing required fields', () => {
    expect(() => zEnvelope.parse({ kind: 'hello', payload: {} })).toThrow();
    expect(() => zEnvelope.parse({ ts: 1, payload: {} })).toThrow();
    expect(() => zEnvelope.parse({ ts: 1, kind: 'hello' })).toThrow();
  });
});

describe('zInventoryFaultPayload', () => {
  it.each([
    'AUTHORITATIVE_INVENTORY_FAILED',
    'AUTHORITATIVE_INVENTORY_TOO_LARGE',
  ] as const)('accepts the fail-stop inventory code %s', (code) => {
    expect(zInventoryFaultPayload.parse({
      serverId: 'server-a',
      code,
      message: 'authoritative inventory is unavailable',
      observedAt: 1,
    }).code).toBe(code);
  });

  it('rejects unknown inventory fault codes', () => {
    expect(() => zInventoryFaultPayload.parse({
      serverId: 'server-a',
      code: 'UNKNOWN',
      message: 'unknown',
      observedAt: 1,
    })).toThrow();
  });
});

describe('zMetricsBatchPayload', () => {
  const point = {
    name: 'nyabase_host_cpu_usage_ratio',
    labels: { server: 'server-a' },
    value: 1,
    ts: 1,
  };

  it('accepts a bounded finite metrics batch', () => {
    expect(zMetricsBatchPayload.parse({ serverId: 'server-a', points: [point] }))
      .toEqual({ serverId: 'server-a', points: [point] });
  });

  it('rejects too many points, labels and unsafe metric syntax', () => {
    expect(() => zMetricsBatchPayload.parse({
      serverId: 'server-a',
      points: Array.from({ length: MAX_METRIC_POINTS_PER_BATCH + 1 }, () => point),
    })).toThrow();
    expect(() => zMetricsBatchPayload.parse({
      serverId: 'server-a',
      points: [{
        ...point,
        labels: Object.fromEntries(Array.from(
          { length: MAX_METRIC_LABELS_PER_POINT + 1 },
          (_, index) => [`label_${index}`, 'value'],
        )),
      }],
    })).toThrow();
    expect(() => zMetricsBatchPayload.parse({
      serverId: 'server-a',
      points: [{ ...point, name: 'metric\nforged', value: Number.POSITIVE_INFINITY }],
    })).toThrow();
    expect(() => zMetricsBatchPayload.parse({
      serverId: 'server-a',
      points: [{ ...point, name: 'syntactically_valid_but_unbounded' }],
    })).toThrow();
    expect(() => zMetricsBatchPayload.parse({
      serverId: 'server-a',
      points: [{ ...point, labels: { server: 'server-a', container_name: 'unbounded' } }],
    })).toThrow();
    expect(() => zMetricsBatchPayload.parse({
      serverId: 'server-a',
      points: [{
        name: 'nyabase_user_disk_used_bytes',
        labels: { server: 'server-a', user_id: 'user-a' },
        value: 1,
        ts: 1,
      }],
    })).toThrow();
  });
});

describe('RemoteFS bootstrap bounds', () => {
  const spec = {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    options: '',
    params: { type: RemoteFsType.Nfs, nfsServer: 'nfs.internal', exportPath: '/data', version: '4.2' },
  } as const;
  const status = {
    id: 'remote-a',
    hostMountPoint: '/mnt/remote-fs/remote-a',
    status: 'mounted',
    lastCheckedAt: 1,
  } as const;

  it('rejects bootstrap payloads and results above the shared assignment cap', () => {
    expect(() => zAgentBootstrapPayload.parse({
      remoteFsMounts: Array.from({ length: MAX_AGENT_REMOTE_FS_MOUNTS + 1 }, () => spec),
    })).toThrow();
    expect(() => zAgentBootstrapResult.parse({
      remoteFsMounts: Array.from({ length: MAX_AGENT_REMOTE_FS_MOUNTS + 1 }, () => status),
    })).toThrow();
  });
});

describe('durable Agent task protocol', () => {
  it('accepts only the strict execute identity and immutable payload', () => {
    const execute = {
      taskId: 'task-a',
      kind: AgentTaskKind.ContainerStart,
      payloadHash: PAYLOAD_HASH,
      payload: { runtimeId: 'runtime-a' },
    };
    expect(zTaskExecutePayload.parse(execute)).toEqual(execute);
    expect(() => zTaskExecutePayload.parse({ ...execute, serverId: 'server-a' })).toThrow();
    expect(() => zTaskExecutePayload.parse({ ...execute, payload: undefined })).toThrow();
    expect(() => zTaskExecutePayload.parse({ ...execute, kind: 'unknown.kind' })).toThrow();
    expect(() => zTaskExecutePayload.parse({ ...execute, payloadHash: 'sha256:payload-a' })).toThrow();
  });

  it('uses strict succeeded/failed/incomplete results and an accepted identity', () => {
    expect(zTaskResultPayload.parse({
      taskId: 'task-a',
      payloadHash: PAYLOAD_HASH,
      status: 'succeeded',
      result: { runtimeId: 'runtime-a' },
    })).toMatchObject({ status: 'succeeded' });
    expect(zTaskResultPayload.parse({
      taskId: 'task-a',
      payloadHash: PAYLOAD_HASH,
      status: 'failed',
      error: { code: 'docker_failed', message: 'failed', details: { exitCode: 1 } },
      observed: { runtimeId: 'runtime-a', running: false },
    })).toMatchObject({ status: 'failed', error: { code: 'docker_failed' } });
    expect(zTaskResultPayload.parse({
      taskId: 'task-a',
      payloadHash: PAYLOAD_HASH,
      status: 'incomplete',
      error: { code: 'docker_ambiguous', message: 'result is not observable yet' },
    })).toMatchObject({ status: 'incomplete' });
    expect(() => zTaskResultPayload.parse({
      taskId: 'task-a', payloadHash: PAYLOAD_HASH, status: 'succeeded', result: {}, error: {},
    })).toThrow();
    expect(() => zTaskResultPayload.parse({
      taskId: 'task-a', payloadHash: PAYLOAD_HASH, status: 'failed', error: { code: 'x', message: 'x' }, observed: {}, retryable: true,
    })).toThrow();
    expect(() => zTaskResultPayload.parse({
      taskId: 'task-a', payloadHash: PAYLOAD_HASH, status: 'failed', error: { code: 'x', message: 'x' },
    })).toThrow();
    expect(() => zTaskResultPayload.parse({
      taskId: 'task-a', payloadHash: PAYLOAD_HASH, status: 'failed', error: { code: 'x', message: 'x' }, observed: null,
    })).toThrow();
    expect(zTaskAcceptedPayload.parse({ taskId: 'task-a', payloadHash: PAYLOAD_HASH }))
      .toEqual({ taskId: 'task-a', payloadHash: PAYLOAD_HASH });
    expect(() => zTaskAcceptedPayload.parse({ taskId: 'task-a', payloadHash: 'hash' })).toThrow();
  });

  it('keeps stop payloads kind-specific', () => {
    expect(zContainerStopTaskPayload.parse({ containerId: 'container-a', runtimeId: 'runtime-a' })).toEqual({
      containerId: 'container-a',
      runtimeId: 'runtime-a',
    });
  });

  it('bounds durable container and runtime identities at exact contract edges', () => {
    const containerAt = (length: number) => 'c'.repeat(length);
    const runtimeAt = (length: number) => 'r'.repeat(length);

    for (const containerId of [containerAt(1), containerAt(128)]) {
      expect(zContainerStopTaskPayload.parse({ containerId, runtimeId: 'r' }).containerId)
        .toBe(containerId);
    }
    for (const containerId of [containerAt(0), containerAt(129)]) {
      expect(() => zContainerStopTaskPayload.parse({ containerId, runtimeId: 'r' })).toThrow();
    }
    for (const runtimeId of [runtimeAt(1), runtimeAt(256)]) {
      expect(zContainerStopTaskPayload.parse({ containerId: 'c', runtimeId }).runtimeId)
        .toBe(runtimeId);
      expect(zContainerSshEnsureTaskPayload.parse({
        containerId: 'c', runtimeId, enabled: false,
      }).runtimeId).toBe(runtimeId);
    }
    for (const runtimeId of [runtimeAt(0), runtimeAt(257)]) {
      expect(() => zContainerStopTaskPayload.parse({ containerId: 'c', runtimeId })).toThrow();
      expect(() => zContainerSshEnsureTaskPayload.parse({
        containerId: 'c', runtimeId, enabled: false,
      })).toThrow();
    }
  });

  it('accepts desired mounts on start payloads', () => {
    const parsed = zContainerStartTaskPayload.parse({
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      dockerRoot: '/var/lib/nyabase-docker',
      quotaGeneration: 1,
      numericOwnerId: 42,
      diskBytes: 1024,
      quotaPaths: [
        '/var/lib/nyabase-docker/overlay/upper',
        '/var/lib/nyabase-docker/overlay/work',
      ],
      mounts: [{
        sourceId: 'disk-a',
        resourceId: 'resource-a',
        sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/work',
      }],
    });
    expect(parsed.mounts).toHaveLength(1);
    expect(() => zContainerStartTaskPayload.parse({
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      dockerRoot: '/var/lib/nyabase-docker',
      quotaGeneration: 1,
      numericOwnerId: 42,
      diskBytes: 1024,
      quotaPaths: [
        '/var/lib/nyabase-docker/overlay/upper',
        '/var/lib/nyabase-docker/overlay/work',
      ],
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/work', hostPath: '/backend-controlled/path',
      }],
    })).toThrow();
    expect('sshServerEnabled' in parsed).toBe(false);
    expect('sshPublicKeys' in parsed).toBe(false);
  });

  it('has one nonterminal and two terminal statuses', () => {
    expect(Object.values(AgentTaskStatus)).toEqual(['pending', 'succeeded', 'failed']);
    expect(Object.keys(agentTaskPayloadSchemas).sort()).toEqual(Object.values(AgentTaskKind).sort());
    expect(parseAgentTaskPayload(AgentTaskKind.ContainerDelete, {
      containerId: 'container-a', runtimeId: null, serverId: 'server-a',
      specGeneration: null, runtimeSpecHash: null, numericOwnerId: 42, quotaPaths: [],
    })).toEqual({
      containerId: 'container-a', runtimeId: null, serverId: 'server-a',
      specGeneration: null, runtimeSpecHash: null, numericOwnerId: 42, quotaPaths: [],
    });
    expect(parseAgentTaskPayload(AgentTaskKind.ContainerRuntimeAbsent, {
      runtimeId: 'runtime-extra',
      containerId: 'container-a',
      serverId: 'server-a',
      specGeneration: '3',
      runtimeSpecHash: 'a'.repeat(64),
      quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
      observedIp: '10.0.0.2',
    })).toEqual({
      runtimeId: 'runtime-extra',
      containerId: 'container-a',
      serverId: 'server-a',
      specGeneration: '3',
      runtimeSpecHash: 'a'.repeat(64),
      quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
      observedIp: '10.0.0.2',
    });
    expect(() => parseAgentTaskPayload(AgentTaskKind.ContainerRuntimeAbsent, {
      runtimeId: 'runtime-extra',
      containerId: 'container-a',
      serverId: 'server-a',
      specGeneration: '3',
      runtimeSpecHash: 'a'.repeat(64),
      quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
      observedIp: '010.0.0.2',
    })).toThrow();
  });
});

describe('data-dir task payloads', () => {
  it('uses only durable resource and source identities for create and delete', () => {
    expect(zDataDirEnsureTaskPayload.parse({
      resourceId: 'datadir-a',
      generation: 1,
      diskId: 'disk-a',
      sourceIdentity: 'local:xfs:uuid-a',
      quotaRequired: true,
      uid: 1001,
      numericUserId: 42,
      quotaGeneration: 2,
      diskBytes: 8192,
    }).resourceId).toBe('datadir-a');
    expect(zDataDirAbsentTaskPayload.parse({
      resourceId: 'datadir-a',
      generation: 2,
      diskId: 'disk-a',
      sourceIdentity: 'local:xfs:uuid-a',
      numericUserId: 42,
    }).resourceId).toBe('datadir-a');
  });

  it('rejects the retired name-addressed physical path', () => {
    expect(() => zDataDirEnsureTaskPayload.parse({
      resourceId: 'datadir-a',
      generation: 1,
      diskId: 'disk-a',
      sourceIdentity: 'local:xfs:uuid-a',
      quotaRequired: true,
      name: 'legacy-name',
      uid: 1001,
      numericUserId: 42,
      quotaGeneration: 2,
      diskBytes: 8192,
    })).toThrow();
  });
});

describe('zHelloPayload', () => {
  it('requires the current complete inventory contract', () => {
    const payload = {
      serverId: 's',
      hostFingerprint: 'a'.repeat(64),
      configFingerprint: 'b'.repeat(64),
      dockerRoot: '/var/lib/nyabase-docker',
      hostname: 'h',
      kernelVersion: '6.0',
      cpuCores: 4,
      totalMemBytes: 1,
      disks: [],
      gpus: [],
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
      macvlanIface: 'eth0',
      agentVersion: '0.1.0',
      localImages: [],
    };
    expect(zHelloPayload.parse(payload).localImages).toEqual([]);
    const incomplete: Partial<typeof payload> = { ...payload };
    delete incomplete.localImages;
    expect(() => zHelloPayload.parse(incomplete)).toThrow();

    const disk = {
      diskId: 'disk-a', mountPoint: '/srv/data', sourceIdentity: 'uuid-a',
      totalBytes: 1024, usedBytes: 0, pquotaEnabled: true,
    };
    expect(() => zHelloPayload.parse({ ...payload, disks: [disk, disk] })).toThrow(
      'inventory identities must be unique',
    );
    const gpu = { index: 0, uuid: 'GPU-a', model: 'Model A', totalMemMiB: 1 };
    expect(() => zHelloPayload.parse({
      ...payload,
      gpus: [gpu, { ...gpu, uuid: 'GPU-b' }],
    })).toThrow('inventory identities must be unique');
    for (const dockerRoot of ['/var/lib/docker/', '/var//lib/docker', '/var/lib/../docker']) {
      expect(() => zHelloPayload.parse({ ...payload, dockerRoot })).toThrow(
        'canonical absolute path',
      );
    }
  });

  it('requires int cpuCores', () => {
    expect(() =>
      zHelloPayload.parse({
        serverId: 's',
        hostFingerprint: 'a'.repeat(64),
        configFingerprint: 'b'.repeat(64),
        hostname: 'h',
        kernelVersion: '6.0',
        cpuCores: 4.5,
        totalMemBytes: 1,
        disks: [],
        gpus: [],
        macvlanCidr: '10.0.0.0/24',
        macvlanGateway: '10.0.0.1',
        macvlanIface: 'eth0',
        agentVersion: '0.1.0',
        localImages: [],
      }),
    ).toThrow();
  });
});

describe('zStateReportPayload', () => {
  it('bounds and validates physical inventory identities before caching them', () => {
    const disk = {
      diskId: 'disk-a',
      mountPoint: '/srv/data',
      sourceIdentity: 'uuid-a',
      label: 'Shared data',
      totalBytes: 1024,
      usedBytes: 512,
      pquotaEnabled: true,
    };
    expect(zDiskInfo.parse(disk)).toEqual(disk);
    for (const invalid of [
      { ...disk, diskId: '../private' },
      { ...disk, mountPoint: 'relative/path' },
      { ...disk, mountPoint: '/srv/data\nother' },
      { ...disk, usedBytes: -1 },
      { ...disk, totalBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...disk, unexpected: true },
    ]) expect(() => zDiskInfo.parse(invalid)).toThrow();

    expect(zGpuInfo.parse({
      index: 0, uuid: 'GPU-a', model: 'Model A', totalMemMiB: 24_576,
    })).toMatchObject({ index: 0, model: 'Model A' });
    expect(() => zGpuInfo.parse({
      index: MAX_AGENT_GPU_DEVICES, uuid: 'GPU-a', model: 'Model A', totalMemMiB: 1,
    })).toThrow();
  });
  it('requires complete image and remote filesystem observations', () => {
    const payload = {
      serverId: 's',
      sequence: 1,
      observedAt: 1,
      containers: [],
      dataDirs: [],
      xfsProjects: [],
      disks: [],
      localImages: [],
      remoteFsMounts: [],
    };
    expect(zStateReportPayload.parse(payload)).toMatchObject(payload);
    const incomplete: Partial<typeof payload> = { ...payload };
    delete incomplete.localImages;
    expect(() => zStateReportPayload.parse(incomplete)).toThrow();
    const disk = {
      diskId: 'disk-a', mountPoint: '/srv/data', sourceIdentity: 'uuid-a',
      totalBytes: 1024, usedBytes: 0, pquotaEnabled: true,
    };
    expect(() => zStateReportPayload.parse({ ...payload, disks: [disk, disk] })).toThrow(
      'Disk inventory identities must be unique',
    );
  });

  it('accepts only safe ordered sequence and bounded Agent epoch values', () => {
    const payload = {
      serverId: 's', sequence: 1, observedAt: Date.now(),
      containers: [], dataDirs: [], xfsProjects: [], disks: [], localImages: [], remoteFsMounts: [],
    };
    expect(zStateReportPayload.parse(payload)).toMatchObject(payload);
    for (const sequence of [Number.MAX_SAFE_INTEGER + 1, 1e300, Number.POSITIVE_INFINITY]) {
      expect(() => zStateReportPayload.parse({ ...payload, sequence })).toThrow();
    }
    for (const observedAt of [
      ECMASCRIPT_DATE_MAX_EPOCH_MS + 1,
      1e300,
      Date.now() + AGENT_PROTOCOL_MAX_FUTURE_CLOCK_SKEW_MS + 10_000,
    ]) {
      expect(() => zStateReportPayload.parse({ ...payload, observedAt })).toThrow();
    }
    const maxDate = new Date(zSafeEpochMs.parse(ECMASCRIPT_DATE_MAX_EPOCH_MS));
    expect(() => maxDate.toISOString()).not.toThrow();
  });

  it('requires finite nonnegative XFS evidence with the deterministic project identity', () => {
    const payload = {
      serverId: 's', sequence: 1, observedAt: 1,
      containers: [], dataDirs: [], disks: [], localImages: [], remoteFsMounts: [],
      xfsProjects: [{
        numericUserId: 7,
        projectId: 10007,
        usedBytes: 0,
        hardLimitBytes: 1024,
      }],
    };
    expect(zStateReportPayload.parse(payload).xfsProjects).toEqual(payload.xfsProjects);
    expect(() => zStateReportPayload.parse({
      ...payload,
      xfsProjects: [{ ...payload.xfsProjects[0], projectId: 10008 }],
    })).toThrow();
    expect(() => zStateReportPayload.parse({
      ...payload,
      xfsProjects: [{ ...payload.xfsProjects[0], usedBytes: -1 }],
    })).toThrow();
    expect(() => zStateReportPayload.parse({
      ...payload,
      xfsProjects: [{ ...payload.xfsProjects[0], hardLimitBytes: Number.POSITIVE_INFINITY }],
    })).toThrow();
    expect(() => zStateReportPayload.parse({
      ...payload,
      xfsProjects: [{ ...payload.xfsProjects[0], usedBytes: Number.MAX_SAFE_INTEGER + 1 }],
    })).toThrow();
  });
});

describe('bounded direct Agent RPC results', () => {
  it('bounds inspectContainer graph recovery paths', () => {
    const base = {
      runtimeId: 'runtime-a', startedAt: '2026-07-17T00:00:00.000Z', running: true,
      graphPaths: ['/docker/upper', '/docker/work'],
    };
    expect(zInspectContainerResult.parse(base)).toEqual(base);
    expect(() => zInspectContainerResult.parse({
      ...base,
      graphPaths: [...base.graphPaths, '/docker/third'],
    })).toThrow();
    expect(() => zInspectContainerResult.parse({
      ...base,
      graphPaths: ['x'.repeat(4097)],
    })).toThrow();
  });

  it('bounds self-check item count and text fields', () => {
    const item = { id: 'docker', label: 'Docker', status: 'ok' as const, message: 'healthy' };
    expect(zSelfCheckResult.parse({ items: [item] })).toEqual({ items: [item] });
    expect(() => zSelfCheckResult.parse({ items: Array.from({ length: 129 }, () => item) })).toThrow();
    expect(() => zSelfCheckResult.parse({
      items: [{ ...item, message: 'x'.repeat(2049) }],
    })).toThrow();
  });
});

describe('zContainerCreateTaskPayload', () => {
  const base = {
    containerId: 'container-a',
    ownerId: 'u',
    numericOwnerId: 1000,
    specGeneration: 1,
    quotaGeneration: 1,
    dockerRoot: '/var/lib/nyabase-docker',
    imageDockerRef: 'nginx:latest',
    imageDockerId: 'sha256:image-a',
    imageId: 'i',
    assignedIp: '10.0.0.2',
    name: 'c',
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 2048,
  };

  it('validates a minimal payload and defaults mounts without SSH public keys', () => {
    const parsed = zContainerCreateTaskPayload.parse(base);
    expect(parsed.mounts).toEqual([]);
    expect('sshServerEnabled' in parsed).toBe(false);
    expect('sshPublicKeys' in parsed).toBe(false);
    expect(parsed.runtimeOverrides).toEqual({ uid: 0, entrypoint: null, cmd: null, init: false });
  });

  it('requires the durable desired generation instead of reviving an implicit generation', () => {
    const withoutGeneration: Partial<typeof base> = { ...base };
    delete withoutGeneration.specGeneration;

    expect(() => zContainerCreateTaskPayload.parse(withoutGeneration)).toThrow();
  });

  it('accepts runtime overrides for Docker create', () => {
    const parsed = zContainerCreateTaskPayload.parse({
      ...base,
      runtimeOverrides: {
        uid: 1000,
        entrypoint: ['/usr/bin/tini', '--'],
        cmd: ['sleep', 'infinity'],
        init: true,
      },
    });

    expect(parsed.runtimeOverrides).toEqual({
      uid: 1000,
      entrypoint: ['/usr/bin/tini', '--'],
      cmd: ['sleep', 'infinity'],
      init: true,
    });
  });

  it('accepts mount specs without container-level SSH controls', () => {
    const parsed = zContainerCreateTaskPayload.parse({
      ...base,
      mounts: [
        {
          sourceId: 'disk-1',
          resourceId: 'resource-1',
          sourceIdentity: 'local:xfs:uuid-1',
          containerPath: '/work',
        },
      ],
    });

    expect('sshServerEnabled' in parsed).toBe(false);
    expect('sshPublicKeys' in parsed).toBe(false);
    expect(parsed.mounts).toEqual([
      {
        sourceId: 'disk-1',
        resourceId: 'resource-1',
        sourceIdentity: 'local:xfs:uuid-1',
        containerPath: '/work',
      },
    ]);
  });

  it.each(['/', '//', '///'])('rejects root mount spelling %j at the Agent task boundary', (containerPath) => {
    expect(() => zContainerCreateTaskPayload.parse({
      ...base,
      mounts: [{
        sourceId: 'disk-1',
        resourceId: 'resource-1',
        sourceIdentity: 'local:xfs:uuid-1',
        containerPath,
      }],
    })).toThrow();
  });

  it('rejects legacy SSH injection fields', () => {
    expect(() => zContainerCreateTaskPayload.parse({
      ...base,
      sshUser: 'legacy',
      sshUid: 1001,
      sshPubKeys: ['ssh-rsa AAAA legacy'],
    })).toThrow();
  });

  it('rejects backend-supplied network fields', () => {
    expect(() => zContainerCreateTaskPayload.parse({
      ...base,
      ipCidr: '10.0.0.0/24',
      gateway: '10.0.0.1',
      reservedIps: [],
    })).toThrow();
  });
});

describe('image runtime override REST schemas', () => {
  it('uses explicit runtime overrides with a clean default', () => {
    const parsed = zCreateImageRequest.parse({
      name: 'Alpine',
      dockerImage: 'alpine:latest',
    });

    expect(parsed.runtimeOverrides).toEqual({
      uid: 0,
      entrypoint: null,
      cmd: null,
      init: false,
    });
    expect(() => zCreateImageRequest.parse({
      name: 'Alpine',
      dockerImage: 'alpine:latest',
      defaultUid: 1000,
    })).toThrow();
  });

  it('preserves an explicit null description on image creation', () => {
    expect(zCreateImageRequest.parse({
      name: 'Alpine',
      dockerImage: 'alpine:latest',
      description: null,
    })).toMatchObject({ description: null });
  });

  it('accepts explicit runtimeOverrides for image update', () => {
    const parsed = zUpdateImageRequest.parse({
      runtimeOverrides: {
        uid: 1001,
        entrypoint: ['/entry'],
        cmd: ['run'],
        init: true,
      },
    });

    expect(parsed.runtimeOverrides).toEqual({
      uid: 1001,
      entrypoint: ['/entry'],
      cmd: ['run'],
      init: true,
    });
  });

  it('requires a safe CAS revision plus a real field for administrative image updates', () => {
    expect(zUpdateAdminImageRequest.parse({ expectedRevision: 7, isActive: false }))
      .toEqual({ expectedRevision: 7, isActive: false });
    expect(() => zUpdateAdminImageRequest.parse({ expectedRevision: 7 })).toThrow();
    for (const expectedRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => zUpdateAdminImageRequest.parse({ expectedRevision, isActive: false })).toThrow();
    }
  });

  it('rejects invalid override uid and empty args', () => {
    expect(() =>
      zCreateImageRequest.parse({
        name: 'bad',
        dockerImage: 'bad:latest',
        runtimeOverrides: { uid: -1, entrypoint: null, cmd: null, init: false },
      }),
    ).toThrow();
    expect(() =>
      zUpdateImageRequest.parse({
        runtimeOverrides: { uid: 0, entrypoint: [''], cmd: null, init: false },
      }),
    ).toThrow();
  });
});

describe('Container SSH protocol state', () => {
  const runtime = {
    runtimeId: 'runtime-1',
    ip: '10.0.0.2',
    serverId: 'srv-1',
    specGeneration: '1',
    quotaPaths: ['/var/lib/nyabase-docker/overlay/upper', '/var/lib/nyabase-docker/overlay/work'],
  };
  const labels = {
    [LABEL.MANAGED]: 'true',
    [LABEL.CONTAINER_ID]: 'container-1',
    [LABEL.SERVER_ID]: 'srv-1',
    [LABEL.SPEC_GENERATION]: '1',
    [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
  };

  it('rejects desired product state from runtime observations', () => {
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, ip: '' })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, ip: '010.000.000.002' })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, name: 'legacy' })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, ownerId: 'legacy' })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, imageId: 'legacy' })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, cpuMillis: 1000 })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, memBytes: 1024 })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, gpuIndices: [] })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, dataDirs: [] })).toThrow();
    expect(() => zContainerRuntimeObservation.parse({ ...runtime, createdAt: new Date(0).toISOString() })).toThrow();
  });

  it('requires runtime SSH server state on snapshots', () => {
    expect(() =>
      zContainerSnapshot.parse({
        runtime,
        status: ContainerStatus.Running,
        labels,
      }),
    ).toThrow();

    const parsed = zContainerSnapshot.parse({
      runtime,
      status: ContainerStatus.Running,
      sshServer: {
        enabled: true,
        status: 'running',
        user: 'root',
        port: 22,
        pid: 22,
        keyHash: 'abc',
        lastReconciledAt: 1,
      },
      labels,
    });
    expect(parsed.sshServer).toMatchObject({
      enabled: true,
      status: 'running',
      user: 'root',
      port: 22,
    });
  });

  it('rejects the removed spec and inline stats snapshot paths', () => {
    const sshServer = { enabled: false, status: 'disabled', user: 'root', port: 22 } as const;

    expect(() => zContainerSnapshot.parse({
      spec: runtime,
      status: ContainerStatus.Running,
      sshServer,
      labels,
    })).toThrow();
    expect(() => zContainerSnapshot.parse({
      runtime,
      status: ContainerStatus.Running,
      sshServer,
      labels,
      stats: null,
    })).toThrow();
    expect(() => zContainerSnapshot.parse({
      runtime,
      status: ContainerStatus.Running,
      sshServer,
      labels: { ...labels, 'external.untrusted': 'noise' },
    })).toThrow();
  });

  it('validates the SSH task with stable container identity and platform key', () => {
    const payload = {
      containerId: 'container-1',
      runtimeId: 'runtime-1',
      internalPublicKey: 'ssh-ed25519 AAAA internal@example',
      internalKeyGeneration: 2,
      expectedKeyHash: 'hash',
    };
    const parsed = zContainerSshEnsureTaskPayload.parse(payload);

    expect(parsed).toEqual({
      containerId: 'container-1',
      runtimeId: 'runtime-1',
      enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA internal@example',
      internalKeyGeneration: 2,
      expectedKeyHash: 'hash',
    });
    expect(() => zContainerSshEnsureTaskPayload.parse({ ...payload, sshPubKeys: ['legacy'] })).toThrow();
    expect(() => zContainerSshEnsureTaskPayload.parse({ containerId: 'container-1', runtimeId: 'runtime-1' })).toThrow();
    expect(zContainerSshEnsureTaskPayload.parse({ containerId: 'container-1', runtimeId: 'runtime-1', enabled: false })).toEqual({
      containerId: 'container-1',
      runtimeId: 'runtime-1',
      enabled: false,
    });
  });

  it('bounds reconcile inventory proof nonces and permits one report echo', () => {
    const proofNonce = 'a'.repeat(64);
    expect(zReconcilePayload.parse({ serverId: 'server-a', proofNonce })).toEqual({
      serverId: 'server-a',
      proofNonce,
    });
    expect(() => zReconcilePayload.parse({ serverId: 'server-a', proofNonce: 'short' })).toThrow();
    expect(zStateReportPayload.parse({
      serverId: 'server-a',
      sequence: 1,
      observedAt: 1,
      reconcileProofNonce: proofNonce,
      containers: [],
      dataDirs: [],
      xfsProjects: [],
      disks: [],
      localImages: [],
      remoteFsMounts: [],
    })).toMatchObject({ reconcileProofNonce: proofNonce });
  });
});

describe('zRemoteFsParams', () => {
  it('discriminates by type (nfs)', () => {
    const parsed = zRemoteFsParams.parse({
      type: RemoteFsType.Nfs,
      nfsServer: 'nfs.example',
      exportPath: '/srv',
      version: '4.2',
    });
    if (parsed.type !== RemoteFsType.Nfs) throw new Error('discriminator failed');
    expect(parsed.nfsServer).toBe('nfs.example');
  });

  it('rejects cephfs without monHosts', () => {
    expect(() =>
      zRemoteFsParams.parse({
        type: RemoteFsType.CephFs,
        monHosts: '',
        exportPath: '/c',
        clientName: 'admin',
        secret: 'x',
      }),
    ).toThrow();
  });
});

describe('remote-fs REST request schemas', () => {
  it('requires cephfs secret on create and makes physical fields immutable', () => {
    expect(() =>
      zCreateRemoteFsMountRequest.parse({
        name: 'ceph-a',
        params: {
          type: RemoteFsType.CephFs,
          monHosts: '10.0.0.1',
          exportPath: '/',
          clientName: 'admin',
        },
      }),
    ).toThrow();

    expect(zCreateRemoteFsMountRequest.parse({
      name: 'ceph-a',
      params: {
        type: RemoteFsType.CephFs,
        monHosts: '10.0.0.1',
        exportPath: '/',
        clientName: 'admin',
        secret: 'AQAB==',
      },
    }).params).toMatchObject({ type: RemoteFsType.CephFs, secret: 'AQAB==' });

    expect(() => zUpdateRemoteFsMountRequest.parse({ options: 'ro' })).toThrow();
    expect(() => zUpdateRemoteFsMountRequest.parse({ hostMountPoint: '/tmp/x' })).toThrow();
    expect(() => zUpdateRemoteFsMountRequest.parse({
      params: {
        type: RemoteFsType.CephFs,
        monHosts: '10.0.0.2',
        exportPath: '/renamed',
        clientName: 'admin',
      },
    })).toThrow();
    expect(zUpdateRemoteFsMountRequest.parse({ name: 'renamed' })).toEqual({ name: 'renamed' });
  });

  it('accepts only real TCP port values in Ceph monitor endpoints', () => {
    const request = (monHosts: string) => ({
      name: 'ceph-a',
      params: {
        type: RemoteFsType.CephFs,
        monHosts,
        exportPath: '/',
        clientName: 'admin',
        secret: 'AQAB==',
      },
    });

    for (const monHosts of [
      'node-a:1',
      'node-a:65535',
      '[2001:db8::1]:6789,node-b',
    ]) {
      expect(zCreateRemoteFsMountRequest.parse(request(monHosts)).params)
        .toMatchObject({ monHosts });
    }
    for (const monHosts of ['node-a:0', 'node-a:65536', 'node-a:99999']) {
      expect(() => zCreateRemoteFsMountRequest.parse(request(monHosts))).toThrow();
    }
  });

  it('rejects argv-breaking parameters and reserved mount options', () => {
    const base = {
      name: 'nfs-a',
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'nfs.example',
        exportPath: '/exports/data',
        version: '4.2' as const,
      },
    };
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'ro,,soft' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'vers=3' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'bg' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'fg' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'ro,rw' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'ro,ro' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({ ...base, options: 'hard,soft' })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({
      ...base,
      params: { ...base.params, nfsServer: '-o' },
    })).toThrow();
    expect(() => zCreateRemoteFsMountRequest.parse({
      ...base,
      params: { ...base.params, exportPath: '/ok\nmalicious' },
    })).toThrow();
  });

  it('allows remove payloads to carry mount coordinates for stateless agent cleanup', () => {
    expect(zRemoteFsAbsentTaskPayload.parse({
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-a',
      options: 'rw',
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'nfs.example',
        exportPath: '/srv',
        version: '4.2',
      },
    })).toMatchObject({
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-a',
      options: 'rw',
      params: { type: RemoteFsType.Nfs },
    });
    expect(() => zRemoteFsAbsentTaskPayload.parse({
      id: 'remote-a',
      hostMountPoint: '/mnt/remote-a',
      options: 'rw',
      params: {
        type: RemoteFsType.Nfs,
        nfsServer: 'nfs.example',
        exportPath: '/srv',
        version: '4.2',
      },
      force: true,
    })).toThrow();
  });
});

describe('REST request schemas', () => {
  it('zLoginRequest rejects empty fields', () => {
    expect(() => zLoginRequest.parse({ username: '', password: 'x' })).toThrow();
  });

  it('zAddSshKeyRequest accepts and normalizes valid one-line OpenSSH public keys', () => {
    expect(zAddSshKeyRequest.parse({
      name: 'ed25519',
      keyText: ` \t ${VALID_ED25519_KEY.replaceAll(' ', '\t  ')} \t `,
    })).toEqual({
      name: 'ed25519',
      keyText: VALID_ED25519_KEY,
    });
    expect(zAddSshKeyRequest.parse({
      name: 'rsa',
      keyText: VALID_RSA_KEY,
    }).keyText).toBe(VALID_RSA_KEY.split(' ').slice(0, 2).join(' '));
    expect(zAddSshKeyRequest.parse({
      name: 'ecdsa',
      keyText: VALID_ECDSA_NISTP256_KEY,
    }).keyText).toBe(VALID_ECDSA_NISTP256_KEY.split(' ').slice(0, 2).join(' '));
    expect(zAddSshKeyRequest.parse({
      name: 'unicode-comment',
      keyText: `${VALID_ED25519_KEY} 用户@工作站`,
    }).keyText).toBe(VALID_ED25519_KEY);
  });

  it('zAddSshKeyRequest rejects malformed, multiline, and mismatched OpenSSH public keys', () => {
    const mismatchedBlob = VALID_ED25519_KEY.replace('ssh-ed25519 ', 'ssh-rsa ');

    for (const keyText of [
      'not-an-ssh-public-key',
      `${VALID_ED25519_KEY}\n${VALID_RSA_KEY}`,
      mismatchedBlob,
    ]) {
      expect(() => zAddSshKeyRequest.parse({ name: 'bad', keyText })).toThrow();
    }
  });

  it('zCreateContainerRequest enforces name regex', () => {
    expect(() =>
      zCreateContainerRequest.parse({
        serverId: 's',
        imageId: 'i',
        name: 'Bad Name',
      }),
    ).toThrow();
  });

  it('zCreateContainerRequest rejects removed container-level SSH request fields', () => {
    expect(() => zCreateContainerRequest.parse({
      serverId: 's',
      imageId: 'i',
      name: 'good-name',
      sshServerEnabled: true,
      sshUser: 'legacy',
      sshUid: 1001,
    })).toThrow();
  });

  it('zCreateContainerRequest accepts only the create-container control surface', () => {
    const parsed = zCreateContainerRequest.parse({
      serverId: 's',
      imageId: 'i',
      name: 'good-name',
      dataDirs: [{
        sourceKind: 'local',
        sourceId: 'disk-a',
        dirName: 'data',
        containerPath: '/data',
      }],
    });

    expect(parsed).toEqual({
      serverId: 's',
      imageId: 'i',
      name: 'good-name',
      dataDirs: [{
        sourceKind: 'local',
        sourceId: 'disk-a',
        dirName: 'data',
        containerPath: '/data',
      }],
    });
  });

  it('zCreateServerRequest accepts server identity only', () => {
    expect(zCreateServerRequest.parse({
      name: 's',
      slug: 'server-a',
    })).toEqual({
      name: 's',
      slug: 'server-a',
    });
    expect(() =>
      zCreateServerRequest.parse({
        name: 's',
        slug: 'server-a',
        defaultCpuMillis: 1000,
      }),
    ).toThrow();
    expect(() =>
      zCreateServerRequest.parse({
        name: 's',
        slug: 'server-a',
        parentIface: 'eth0',
      }),
    ).toThrow();
    expect(() =>
      zCreateServerRequest.parse({
        name: 's',
        slug: 'BadSlug',
      }),
    ).toThrow();
  });
});

describe('SSH proxy route protocol', () => {
  const snapshot = {
    users: [{
      id: 'user-a',
      username: 'alice',
      status: UserStatus.Active,
      publicKeys: ['ssh-ed25519 AAAA alice@example'],
      internalPrivateKey: 'PRIVATE',
      internalPublicKey: 'ssh-ed25519 AAAA internal@example',
      internalKeyFingerprint: 'SHA256:internal',
      internalKeyGeneration: 1,
    }],
    servers: [
      { id: 'server-a', slug: 'cpu-a', name: 'CPU A', online: true },
      { id: 'server-b', slug: 'cpu-b', name: 'CPU B', online: true },
    ],
    images: [{ id: 'image-a', disableSsh: false }],
    containers: [
      { id: 'container-a', ownerId: 'user-a', serverId: 'server-a', imageId: 'image-a', name: 'work' },
      { id: 'container-b', ownerId: 'user-a', serverId: 'server-b', imageId: 'image-a', name: 'work' },
      { id: 'container-c', ownerId: 'user-a', serverId: 'server-a', imageId: 'image-a', name: 'solo' },
    ],
    routes: [
      { containerId: 'container-a', serverId: 'server-a', runtimeId: 'runtime-a', macvlanIp: '10.0.0.2', runtimeStatus: ContainerStatus.Running, sshStatus: 'running' as const, appliedInternalKeyGeneration: 1, containerHostKeyFingerprint: 'SHA256:host-a', observedAt: new Date(0).toISOString() },
      { containerId: 'container-b', serverId: 'server-b', runtimeId: 'runtime-b', macvlanIp: '10.0.0.3', runtimeStatus: ContainerStatus.Running, sshStatus: 'running' as const, appliedInternalKeyGeneration: 1, containerHostKeyFingerprint: 'SHA256:host-b', observedAt: new Date(0).toISOString() },
      { containerId: 'container-c', serverId: 'server-a', runtimeId: 'runtime-c', macvlanIp: '10.0.0.4', runtimeStatus: ContainerStatus.Running, sshStatus: 'running' as const, appliedInternalKeyGeneration: 1, containerHostKeyFingerprint: 'SHA256:host-c', observedAt: new Date(0).toISOString() },
    ],
  };

  it('accepts only the bounded SSH control-plane lease', () => {
    const wireSnapshot = {
      ...snapshot,
      generation: 1,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
      validUntil: SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
      endpoint: null,
      hostKey: {
        privateKey: 'PRIVATE',
        publicKey: 'PUBLIC',
        fingerprint: 'SHA256:host',
        generation: 1,
      },
    };
    expect(zSshProxySnapshot.safeParse(wireSnapshot).success).toBe(true);
    expect(zSshProxySnapshot.safeParse({
      ...wireSnapshot,
      staleAfterMs: SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
    }).success).toBe(true);
    expect(zSshProxySnapshot.safeParse({
      ...wireSnapshot,
      staleAfterMs: SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1,
    }).success).toBe(false);
    expect(zSshProxySnapshot.safeParse({
      ...wireSnapshot,
      staleAfterMs: SSH_PROXY_SNAPSHOT_STALE_MAX_MS + 1,
    }).success).toBe(false);
  });

  it('parses two-part and three-part logins case-insensitively', () => {
    expect(parseSshProxyLogin('Alice.Work')).toEqual({ username: 'alice', serverSlug: null, containerName: 'work' });
    expect(parseSshProxyLogin('Alice.CPU-A.Work')).toEqual({ username: 'alice', serverSlug: 'cpu-a', containerName: 'work' });
    expect(parseSshProxyLogin('alice.cpu-a.work.extra')).toBeNull();
  });

  it('rejects omitted server when multiple active container routes match', () => {
    const ambiguous = resolveSshProxyRoute(snapshot, 'alice.work');
    expect(ambiguous).toMatchObject({ ok: false, reason: 'ambiguous_container' });
    if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(2);
  });

  it('accepts omitted server for exactly one active route and explicit server for duplicates', () => {
    expect(resolveSshProxyRoute(snapshot, 'alice.solo')).toMatchObject({
      ok: true,
      container: { id: 'container-c' },
    });
    expect(resolveSshProxyRoute(snapshot, 'alice.cpu-b.work')).toMatchObject({
      ok: true,
      container: { id: 'container-b' },
      server: { slug: 'cpu-b' },
    });
  });
});

describe('Control-plane REST protocol exports', () => {
  it('exports the single Agent task enums and DTOs', () => {
    const taskRef: AgentTaskRefResponse = {
      ok: true,
      taskId: 'task-a',
      status: AgentTaskStatus.Pending,
    };
    const task: AgentTaskDto = {
      id: 'task-a',
      kind: AgentTaskKind.ContainerCreate,
      status: AgentTaskStatus.Pending,
      resourceType: 'container',
      resourceId: 'container-a',
      serverId: 'server-a',
      requestedBy: 'user-a',
      request: { name: 'demo' },
      agentResult: null,
      result: null,
      error: null,
      failureStage: null,
      createdAt: new Date(0).toISOString(),
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
      retentionUntil: null,
    };
    const requesterTask: UserAgentTaskDto = {
      id: task.id,
      kind: task.kind,
      status: task.status,
      resourceType: task.resourceType,
      resourceId: task.resourceId,
      serverId: task.serverId,
      error: null,
      failureStage: null,
      createdAt: task.createdAt,
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
      retentionUntil: null,
    };
    expect(taskRef.status).toBe(AgentTaskStatus.Pending);
    expect(task.kind).toBe(AgentTaskKind.ContainerCreate);
    expect(requesterTask).not.toHaveProperty('request');
    expect(RuntimeDriftKind.SpecGenerationMismatch).toBe('spec_generation_mismatch');
    expect(zEnvelope.parse({ ts: 1, kind: 'hello', payload: {} }).kind).toBe('hello');
    expect(ContainerStatus.Running).toBe('running');
    expect(RemoteFsType.Nfs).toBe('nfs');

    const barrelSource = readFileSync(commonSrcPath('index.ts'), 'utf8');
    const restSource = readFileSync(commonSrcPath('protocol/rest.ts'), 'utf8');
    expect(barrelSource).toContain("export * from './protocol/rest.js'");
    for (const dtoName of [
      'AgentTaskRefResponse',
      'AgentTaskDto',
      'UserAgentTaskDto',
      'RuntimeDriftDto',
      'RuntimeStalenessDto',
    ]) {
      expect(restSource).toContain(`export interface ${dtoName}`);
    }
  });
});

describe('SSH proxy admin status protocol', () => {
  it('validates live status reports and disconnect command results', () => {
    const status = zSshProxyStatusReport.parse({
      proxyId: 'proxy-a',
      hostname: 'host-a',
      listen: '0.0.0.0:2222',
      uptimeMs: 1000,
      connectedAt: 1,
      lastSnapshotGeneration: 2,
      lastSnapshotAt: 3,
      activeConnections: 1,
      totalConnections: 4,
      totalRejectedConnections: 0,
      totalClosedConnections: 3,
      totalBytesFromClient: 1024,
      totalBytesToClient: 2048,
      bandwidthInBps: 10,
      bandwidthOutBps: 20,
      connections: [{
        id: 'conn-1',
        peer: '127.0.0.1:55555',
        username: 'alice',
        login: 'alice.cpu-a.work',
        serverSlug: 'cpu-a',
        serverId: 'server-a',
        containerName: 'work',
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        connectedAt: 1,
        authenticatedAt: 2,
        bytesFromClient: 100,
        bytesToClient: 200,
        channels: 1,
      }],
    });

    expect(status.activeConnections).toBe(1);
    expect(status.connections[0].containerName).toBe('work');
    const requestId = 'a'.repeat(24);
    expect(zSshProxyDisconnectAllCommand.parse({ requestId }).requestId).toBe(requestId);
    expect(zSshProxyDisconnectAllResult.parse({ requestId, disconnected: 1 }).disconnected).toBe(1);
  });

  it('strictly bounds disconnect-all commands and proxy results', () => {
    const requestId = 'a'.repeat(24);
    for (const candidate of [
      { requestId: 'req-a', disconnected: 1 },
      { requestId, disconnected: MAX_SSH_PROXY_STATUS_CONNECTIONS + 1 },
      { requestId, disconnected: 1e300 },
      { requestId, disconnected: 1, unexpected: true },
    ]) {
      expect(zSshProxyDisconnectAllResult.safeParse(candidate).success).toBe(false);
    }
    expect(zSshProxyDisconnectAllCommand.safeParse({
      requestId,
      reason: 'x'.repeat(513),
    }).success).toBe(false);
    expect(zSshProxyDisconnectAllCommand.safeParse({
      requestId,
      reason: 'bounded',
      unexpected: true,
    }).success).toBe(false);
  });

  it('rejects unbounded, unknown, unsafe-counter, and invalid-clock status evidence', () => {
    const connection = {
      id: 'conn-1',
      peer: '127.0.0.1:55555',
      username: null,
      login: null,
      serverSlug: null,
      serverId: null,
      containerName: null,
      containerId: null,
      runtimeId: null,
      connectedAt: 1,
      authenticatedAt: null,
      bytesFromClient: 0,
      bytesToClient: 0,
      channels: 0,
    };
    const valid = {
      proxyId: 'proxy-a',
      hostname: 'host-a',
      listen: '0.0.0.0:2222',
      uptimeMs: 1000,
      connectedAt: 1,
      lastSnapshotGeneration: 2,
      lastSnapshotAt: 3,
      activeConnections: 0,
      totalConnections: 4,
      totalRejectedConnections: 0,
      totalClosedConnections: 3,
      totalBytesFromClient: 1024,
      totalBytesToClient: 2048,
      bandwidthInBps: 10,
      bandwidthOutBps: 20,
      connections: [],
    };
    const invalid = [
      { ...valid, proxyId: 'p'.repeat(129) },
      { ...valid, connectedAt: 1e300 },
      { ...valid, lastSnapshotAt: Date.now() + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS + 60_000 },
      { ...valid, totalConnections: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, unexpected: true },
      { ...valid, activeConnections: 1 },
      {
        ...valid,
        activeConnections: MAX_SSH_PROXY_STATUS_CONNECTIONS + 1,
        connections: Array(MAX_SSH_PROXY_STATUS_CONNECTIONS + 1).fill(connection),
      },
      { ...valid, activeConnections: 1, connections: [{ ...connection, unexpected: true }] },
    ];
    for (const candidate of invalid) {
      expect(zSshProxyStatusReport.safeParse(candidate).success).toBe(false);
    }
  });
});

describe('HTTP proxy route protocol', () => {
  const snapshot = zHttpProxySnapshot.parse({
    generation: 1,
    createdAt: new Date(0).toISOString(),
    staleAfterMs: 30_000,
    validUntil: 30_000,
    routes: [{
      bindingId: 'binding-a',
      hostname: 'app.apps.example.test',
      domainPoolId: 'pool-a',
      targetIp: '10.0.0.8',
      targetPort: 8080,
      ownerId: 'user-a',
      containerId: 'container-a',
      containerName: 'app',
      runtimeId: 'runtime-a',
      runtimeStatus: ContainerStatus.Running,
    }],
    domainPools: [{
      id: 'pool-a',
      wildcardDomain: '*.apps.example.test',
      enabled: true,
      httpsEnabled: true,
      certificatePem: 'CERT',
      privateKeyPem: 'KEY',
      certificateFingerprint: 'SHA256:FINGERPRINT',
      certificateNotAfter: new Date(86400_000).toISOString(),
    }],
  });

  it('requires an explicit bounded snapshot lease', () => {
    expect(zHttpProxySnapshot.safeParse({
      generation: 2,
      createdAt: new Date(0).toISOString(),
      routes: [],
      domainPools: [],
    }).success).toBe(false);
    expect(zHttpProxySnapshot.safeParse({
      generation: 2,
      createdAt: new Date(0).toISOString(),
      staleAfterMs: 300_001,
      routes: [],
      domainPools: [],
    }).success).toBe(false);
  });

  it('normalizes hostnames and wildcard domains', () => {
    expect(normalizeHttpProxyHostname(' App.Apps.Example.Test. ')).toBe('app.apps.example.test');
    expect(normalizeHttpProxyWildcardDomain('apps.example.test')).toBe('*.apps.example.test');
  });

  it('matches one label below wildcard root only', () => {
    expect(hostnameMatchesHttpProxyWildcard('app.apps.example.test', '*.apps.example.test')).toBe(true);
    expect(hostnameMatchesHttpProxyWildcard('deep.app.apps.example.test', '*.apps.example.test')).toBe(false);
    expect(hostnameMatchesHttpProxyWildcard('apps.example.test', '*.apps.example.test')).toBe(false);
  });

  it('resolves Host headers with optional ports', () => {
    expect(resolveHttpProxyRoute(snapshot, 'App.Apps.Example.Test:8080')?.bindingId).toBe('binding-a');
    expect(resolveHttpProxyRoute(snapshot, 'missing.apps.example.test')).toBeNull();
  });

  it('validates status reports and warning messages', () => {
    const status = zHttpProxyStatusReport.parse({
      proxyId: 'proxy-a',
      hostname: 'host-a',
      httpListen: '0.0.0.0:8080',
      httpsListen: '0.0.0.0:8443',
      uptimeMs: 100,
      connectedAt: 1,
      lastSnapshotGeneration: 1,
      lastSnapshotAt: 2,
      activeConnections: 1,
      totalRequests: 3,
      totalRejectedRequests: 1,
    });
    expect(status.totalRequests).toBe(3);
    expect(httpProxyWarningMessage(['container_ip_missing', 'proxy_offline'])).toContain('容器 IP 缺失');
  });

  it('rejects unbounded, unknown, unsafe-counter, and invalid-clock HTTP status evidence', () => {
    const valid = {
      proxyId: 'proxy-a',
      hostname: 'host-a',
      httpListen: '0.0.0.0:8080',
      httpsListen: null,
      uptimeMs: 100,
      connectedAt: 1,
      lastSnapshotGeneration: 1,
      lastSnapshotAt: 2,
      activeConnections: 1,
      totalRequests: 3,
      totalRejectedRequests: 1,
    };
    for (const candidate of [
      { ...valid, hostname: 'h'.repeat(254) },
      { ...valid, connectedAt: 1e300 },
      { ...valid, lastSnapshotAt: Date.now() + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS + 60_000 },
      { ...valid, totalRequests: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, activeConnections: MAX_HTTP_PROXY_ACTIVE_CONNECTIONS + 1 },
      { ...valid, unexpected: true },
    ]) {
      expect(zHttpProxyStatusReport.safeParse(candidate).success).toBe(false);
    }
  });
});

describe('Docker label constants', () => {
  it('uses only the current immutable identity labels', () => {
    expect(LABEL).toEqual({
      MANAGED: 'nyabase.managed',
      CONTAINER_ID: 'nyabase.container_id',
      SERVER_ID: 'nyabase.server_id',
      SPEC_GENERATION: 'nyabase.spec_generation',
      RUNTIME_SPEC_HASH: 'nyabase.runtime_spec_hash',
    });
    expect('OWNER_ID' in LABEL).toBe(false);
    expect('CONTAINER_NAME' in LABEL).toBe(false);
    expect('IMAGE_ID' in LABEL).toBe(false);
  });
});
