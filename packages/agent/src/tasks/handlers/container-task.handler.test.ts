import { AgentTaskKind, LABEL } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../config.js';
import type { DataDirsManager } from '../../datadirs/data-dirs.js';
import type { DockerClient } from '../../docker/docker-client.js';
import type { DropbearManager } from '../../dropbear/dropbear-manager.js';
import type { RemoteFsMounter } from '../../fs/remote-fs-mounter.js';
import type { XfsQuotaManager } from '../../quota/xfs-quota.js';
import { IncompleteTaskError, ManagedTaskError } from '../task-handler.js';
import { ContainerTaskHandler } from './container-task.handler.js';

const config = {
  backendUrl: 'ws://localhost:3001/ws/agent',
  agentToken: '0123456789abcdef',
  serverId: 'server-a',
  dockerRoot: '/var/lib/nyabase-docker',
  parentIface: 'eth0',
  macvlanCidr: '10.0.0.0/24',
  macvlanGateway: '10.0.0.1',
  reservedIps: [],
  metricsIntervalMs: 10_000,
  isGpuServer: false,
  dockerResourceLimit: { enabled: false },
  localDataSources: [],
  agentVersion: 'test',
} satisfies AgentConfig;

const powerQuota = {
  dockerRoot: config.dockerRoot,
  quotaGeneration: 1,
  numericOwnerId: 7,
  diskBytes: 2048,
  quotaPaths: [
    '/var/lib/nyabase-docker/overlay/upper',
    '/var/lib/nyabase-docker/overlay/work',
  ],
} as const;

const SPEC_HASH = 'a'.repeat(64);

const runtimeAbsentPayload = {
  runtimeId: 'runtime-extra',
  containerId: 'container-a',
  serverId: config.serverId,
  specGeneration: '3',
  runtimeSpecHash: SPEC_HASH,
  quotaPaths: powerQuota.quotaPaths,
  observedIp: '10.0.0.55',
} as const;

function labels(containerId = 'container-a', runtimeSpecHash = SPEC_HASH) {
  return {
    [LABEL.MANAGED]: 'true',
    [LABEL.CONTAINER_ID]: containerId,
    [LABEL.SERVER_ID]: config.serverId,
    [LABEL.SPEC_GENERATION]: '1',
    [LABEL.RUNTIME_SPEC_HASH]: runtimeSpecHash,
  };
}

function inspectInfo(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'runtime-a',
    Image: 'sha256:image-a',
    Config: { Labels: labels() },
    State: {
      Running: true,
      Status: 'running',
      StartedAt: '2026-07-15T01:00:01.000000000Z',
      Pid: 0,
    },
    Mounts: [],
    NetworkSettings: {
      Networks: { nyabase_net: { IPAddress: '10.0.0.2' } },
    },
    ...overrides,
  };
}

function cleanupInspect(running: boolean, containerId: string = runtimeAbsentPayload.containerId) {
  return inspectInfo({
    Id: runtimeAbsentPayload.runtimeId,
    Config: {
      Labels: {
        ...labels(containerId),
        [LABEL.SPEC_GENERATION]: runtimeAbsentPayload.specGeneration,
      },
    },
    State: {
      ...inspectInfo().State,
      Running: running,
      Status: running ? 'running' : 'exited',
    },
  });
}

function makeHandler(
  dockerOverrides: Record<string, unknown> = {},
  quotaOverrides: Record<string, unknown> = {},
  dropbearOverrides: Record<string, unknown> = {},
  dataDirsOverrides: Record<string, unknown> = {},
  remoteFsOverrides: Record<string, unknown> = {},
) {
  const docker = {
    listNyabaseContainers: vi.fn().mockResolvedValue([]),
    listAllContainers: vi.fn().mockResolvedValue([]),
    inspectContainer: vi.fn().mockResolvedValue(inspectInfo()),
    runtimeSpecHash: vi.fn().mockReturnValue(SPEC_HASH),
    allocateNextIp: vi.fn().mockResolvedValue('10.0.0.2'),
    createContainer: vi.fn().mockResolvedValue('runtime-a'),
    startContainer: vi.fn().mockResolvedValue(undefined),
    stopContainer: vi.fn().mockResolvedValue(undefined),
    restartContainer: vi.fn().mockResolvedValue(undefined),
    removeContainer: vi.fn().mockResolvedValue(undefined),
    getGraphDriverDirs: vi.fn().mockResolvedValue({
      upperDir: '/var/lib/nyabase-docker/overlay/upper',
      workDir: '/var/lib/nyabase-docker/overlay/work',
    }),
    ...dockerOverrides,
  };
  const quota = {
    projectIdForUser: vi.fn((numericUserId: number) => numericUserId + 10_000),
    ensureProjectForUser: vi.fn().mockResolvedValue(10007),
    setLimit: vi.fn().mockResolvedValue(undefined),
    getUsageForUser: vi.fn().mockResolvedValue({
      numericUserId: 7,
      projectId: 10007,
      usedBytes: 0,
      hardLimitBytes: 2048,
    }),
    addPathToProject: vi.fn().mockResolvedValue(undefined),
    removePathFromProject: vi.fn(),
    isPathRegisteredToProject: vi.fn().mockReturnValue(false),
    inspectPathAssignment: vi.fn().mockResolvedValue({ assigned: true }),
    inspectExactPathRegistration: vi.fn((quotaPath: string) => ({ quotaPath, projectId: null })),
    removeExactPathRegistration: vi.fn((quotaPath: string) => ({ quotaPath, projectId: 10007 })),
    ...quotaOverrides,
  };
  const dropbear = {
    reconcileContainerSsh: vi.fn().mockResolvedValue({
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    }),
    inspectContainerSshState: vi.fn().mockResolvedValue({
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    }),
    ...dropbearOverrides,
  };
  const dataDirs = {
    inspectSource: vi.fn().mockReturnValue({
      sourceId: 'disk-a', kind: 'local', root: '/data', identity: 'local:xfs:uuid-a',
      configured: true, exists: true, isDirectory: true, mounted: true, fsType: 'xfs', ready: true, device: '1',
    }),
    resolveMountPath: vi.fn().mockResolvedValue('/tmp'),
    inspectDir: vi.fn().mockReturnValue({
      path: '/tmp', exists: true, isDirectory: true, uid: 1000, gid: 1000, resourceId: 'resource-a',
    }),
    ...dataDirsOverrides,
  };
  if (!('inspectSourceExact' in dataDirsOverrides)) {
    (dataDirs as Record<string, unknown>).inspectSourceExact = vi.fn(async (sourceId: string) =>
      dataDirs.inspectSource(sourceId));
  }
  if (!('inspectDirExact' in dataDirsOverrides)) {
    (dataDirs as Record<string, unknown>).inspectDirExact = vi.fn(async (sourceId: string, resourceId: string) =>
      dataDirs.inspectDir(sourceId, resourceId));
  }
  const remoteFsMounter = {
    getSpec: vi.fn().mockReturnValue(undefined),
    verifyMounted: vi.fn().mockResolvedValue(false),
    ...remoteFsOverrides,
  };
  return {
    handler: new ContainerTaskHandler(
      config,
      docker as unknown as DockerClient,
      quota as unknown as XfsQuotaManager,
      dropbear as unknown as DropbearManager,
      dataDirs as unknown as DataDirsManager,
      remoteFsMounter as unknown as RemoteFsMounter,
    ),
    docker,
    quota,
    dropbear,
    dataDirs,
    remoteFsMounter,
  };
}

describe('ContainerTaskHandler steady-state recovery', () => {
  it('stops and removes the exact runtime before scrubbing its proven-exclusive registrations', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const order: string[] = [];
    let present = true;
    let running = true;
    const registrations = new Map<string, number>(
      runtimeAbsentPayload.quotaPaths.map((quotaPath) => [quotaPath, 10007]),
    );
    const inspectContainer = vi.fn(async () => {
      if (!present) throw notFound;
      return cleanupInspect(running);
    });
    const { handler, docker, quota } = makeHandler({
      inspectContainer,
      stopContainer: vi.fn(async () => { order.push('docker:stop'); running = false; }),
      removeContainer: vi.fn(async () => { order.push('docker:remove'); present = false; }),
    }, {
      inspectExactPathRegistration: vi.fn((quotaPath: string) => ({
        path: quotaPath,
        projectId: registrations.get(quotaPath) ?? null,
      })),
      removeExactPathRegistration: vi.fn((quotaPath: string) => {
        order.push(`xfs:${quotaPath}`);
        registrations.delete(quotaPath);
        return { path: quotaPath, projectId: 10007 };
      }),
    });

    const result = await handler.ensure(AgentTaskKind.ContainerRuntimeAbsent, runtimeAbsentPayload);
    await expect(handler.verify(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
      result,
    )).resolves.toBeUndefined();

    expect(docker.stopContainer).toHaveBeenCalledWith(runtimeAbsentPayload.runtimeId);
    expect(docker.removeContainer).toHaveBeenCalledWith(runtimeAbsentPayload.runtimeId, false);
    expect(quota.removeExactPathRegistration).toHaveBeenCalledTimes(2);
    expect(order).toEqual([
      'docker:stop',
      'docker:remove',
      `xfs:${runtimeAbsentPayload.quotaPaths[0]}`,
      `xfs:${runtimeAbsentPayload.quotaPaths[1]}`,
    ]);
    expect(result).toEqual({
      containerId: runtimeAbsentPayload.containerId,
      runtimeId: null,
      quotaPaths: [...runtimeAbsentPayload.quotaPaths],
    });
  });

  it('replays an already-absent runtime by proving no references and scrubbing persisted paths', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const registrations = new Map<string, number>([
      [runtimeAbsentPayload.quotaPaths[1], 10007],
    ]);
    const { handler, docker, quota } = makeHandler({
      inspectContainer: vi.fn().mockRejectedValue(notFound),
    }, {
      inspectExactPathRegistration: vi.fn((quotaPath: string) => ({
        path: quotaPath,
        projectId: registrations.get(quotaPath) ?? null,
      })),
      removeExactPathRegistration: vi.fn((quotaPath: string) => {
        registrations.delete(quotaPath);
        return { path: quotaPath, projectId: 10007 };
      }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).resolves.toEqual({
      containerId: runtimeAbsentPayload.containerId,
      runtimeId: null,
      quotaPaths: [...runtimeAbsentPayload.quotaPaths],
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(docker.listAllContainers).toHaveBeenCalled();
    expect(quota.removeExactPathRegistration).toHaveBeenCalledExactlyOnceWith(
      runtimeAbsentPayload.quotaPaths[1],
    );
  });

  it('converges after a crash-shaped partial exact-registration cleanup', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const registrations = new Map<string, number>(
      runtimeAbsentPayload.quotaPaths.map((quotaPath) => [quotaPath, 10007]),
    );
    let failSecond = true;
    const { handler, quota } = makeHandler({
      inspectContainer: vi.fn().mockRejectedValue(notFound),
    }, {
      inspectExactPathRegistration: vi.fn((quotaPath: string) => ({
        path: quotaPath,
        projectId: registrations.get(quotaPath) ?? null,
      })),
      removeExactPathRegistration: vi.fn((quotaPath: string) => {
        if (quotaPath === runtimeAbsentPayload.quotaPaths[1] && failSecond) {
          throw new Error('simulated crash boundary');
        }
        registrations.delete(quotaPath);
        return { path: quotaPath, projectId: 10007 };
      }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toBeInstanceOf(IncompleteTaskError);
    expect(registrations.has(runtimeAbsentPayload.quotaPaths[0])).toBe(false);
    expect(registrations.has(runtimeAbsentPayload.quotaPaths[1])).toBe(true);

    failSecond = false;
    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).resolves.toMatchObject({ runtimeId: null, quotaPaths: [...runtimeAbsentPayload.quotaPaths] });
    expect(registrations.size).toBe(0);
    expect(quota.removeExactPathRegistration).toHaveBeenCalledTimes(3);
  });

  it('never mutates a reused runtime id whose immutable label identity changed', async () => {
    const reused = inspectInfo({
      Id: runtimeAbsentPayload.runtimeId,
      Config: {
        Labels: {
          ...labels('container-reused'),
          [LABEL.SPEC_GENERATION]: runtimeAbsentPayload.specGeneration,
        },
      },
    });
    const { handler, docker } = makeHandler({
      inspectContainer: vi.fn().mockResolvedValue(reused),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_runtime_cleanup_identity_mismatch' },
      observed: { applied: false, present: true },
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
  });

  it('fails closed before stop when the reported writable-layer paths no longer match', async () => {
    const { handler, docker, quota } = makeHandler({
      inspectContainer: vi.fn().mockResolvedValue(cleanupInspect(true)),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: '/var/lib/nyabase-docker/overlay/other-upper',
        workDir: '/var/lib/nyabase-docker/overlay/other-work',
      }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toMatchObject({
      taskError: { code: 'container_runtime_cleanup_paths_mismatch' },
      observed: { applied: false },
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('fails closed before stop when an exact XFS registration is ambiguous', async () => {
    const { handler, docker, quota } = makeHandler({
      inspectContainer: vi.fn().mockResolvedValue(cleanupInspect(true)),
    }, {
      inspectExactPathRegistration: vi.fn(() => {
        throw new Error('ambiguous duplicate registrations');
      }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'container_runtime_cleanup_registration_ambiguous' },
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('keeps cleanup incomplete without XFS or remove when identity changes after stop', async () => {
    const inspectContainer = vi.fn()
      .mockResolvedValueOnce(cleanupInspect(true))
      .mockResolvedValueOnce(cleanupInspect(true))
      .mockResolvedValue(cleanupInspect(false, 'container-reused'));
    const { handler, docker, quota } = makeHandler({ inspectContainer });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toBeInstanceOf(IncompleteTaskError);
    expect(docker.stopContainer).toHaveBeenCalledOnce();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('does not scrub an absent runtime path while another runtime references it', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const other = inspectInfo({ Id: 'runtime-other' });
    const { handler, docker, quota } = makeHandler({
      inspectContainer: vi.fn(async (runtimeId: string) => {
        if (runtimeId === runtimeAbsentPayload.runtimeId) throw notFound;
        return other;
      }),
      listAllContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-other' }]),
      getGraphDriverDirs: vi.fn().mockResolvedValue({
        upperDir: runtimeAbsentPayload.quotaPaths[0],
        workDir: '/var/lib/nyabase-docker/overlay/other-work',
      }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toMatchObject({
      taskError: { code: 'container_runtime_cleanup_path_referenced' },
      observed: { applied: false, referencingRuntimeId: 'runtime-other' },
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('removes the exact drift runtime but never scrubs a path still referenced by another runtime', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    let targetPresent = true;
    let targetRunning = true;
    const other = inspectInfo({ Id: 'runtime-other' });
    const { handler, docker, quota } = makeHandler({
      inspectContainer: vi.fn(async (runtimeId: string) => {
        if (runtimeId === runtimeAbsentPayload.runtimeId) {
          if (!targetPresent) throw notFound;
          return cleanupInspect(targetRunning);
        }
        return other;
      }),
      stopContainer: vi.fn(async () => { targetRunning = false; }),
      removeContainer: vi.fn(async () => { targetPresent = false; }),
      listAllContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-other' }]),
      getGraphDriverDirs: vi.fn(async (runtimeId: string) => runtimeId === 'runtime-other'
        ? {
          upperDir: runtimeAbsentPayload.quotaPaths[0],
          workDir: '/var/lib/nyabase-docker/overlay/other-work',
        }
        : {
          upperDir: runtimeAbsentPayload.quotaPaths[0],
          workDir: runtimeAbsentPayload.quotaPaths[1],
        }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'container_runtime_cleanup_path_referenced' },
    });
    expect(docker.stopContainer).toHaveBeenCalledOnce();
    expect(docker.removeContainer).toHaveBeenCalledOnce();
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('keeps an absent-runtime cleanup incomplete when full inventory paths are unobservable', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const { handler, quota } = makeHandler({
      inspectContainer: vi.fn(async (runtimeId: string) => {
        if (runtimeId === runtimeAbsentPayload.runtimeId) throw notFound;
        return inspectInfo({ Id: runtimeId });
      }),
      listAllContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-other' }]),
      getGraphDriverDirs: vi.fn().mockResolvedValue({ upperDir: '', workDir: '' }),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toBeInstanceOf(IncompleteTaskError);
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('keeps cleanup incomplete when all-container inspect returns a different runtime id', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const { handler, quota } = makeHandler({
      inspectContainer: vi.fn(async (runtimeId: string) => {
        if (runtimeId === runtimeAbsentPayload.runtimeId) throw notFound;
        return inspectInfo({ Id: 'runtime-different' });
      }),
      listAllContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-listed' }]),
    });

    await expect(handler.ensure(
      AgentTaskKind.ContainerRuntimeAbsent,
      runtimeAbsentPayload,
    )).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'container_runtime_cleanup_inventory_invalid' },
    });
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });

  it('derives Docker bind sources from the Agent DataDir marker instead of Backend paths', async () => {
    const inspectContainer = vi.fn().mockResolvedValue(inspectInfo({
      Mounts: [{ Type: 'bind', Source: '/tmp', Destination: '/workspace' }],
    }));
    const { handler, docker, dataDirs } = makeHandler({ inspectContainer });
    const payload = {
      ...createPayload(),
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/workspace',
      }],
    };

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, payload)).resolves.toMatchObject({
      runtimeId: 'runtime-a',
      mounts: [{ src: '/tmp', dst: '/workspace' }],
    });
    expect(dataDirs.resolveMountPath).toHaveBeenCalledWith('disk-a', 'resource-a', 'local:xfs:uuid-a');
    expect(docker.createContainer).toHaveBeenCalledWith(expect.objectContaining({
      mounts: [expect.objectContaining({
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        hostPath: '/tmp', containerPath: '/workspace',
      })],
    }));
  });

  it('performs no quota or Docker mutation when a DataDir source identity is unavailable', async () => {
    const { handler, docker, quota } = makeHandler({}, {}, {}, {
      inspectSource: vi.fn().mockReturnValue({
        sourceId: 'disk-a', kind: 'local', root: '/data', identity: 'local:xfs:other',
        configured: true, exists: true, isDirectory: true, mounted: true, fsType: 'xfs', ready: false, device: '1',
      }),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, {
      ...createPayload(),
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/workspace',
      }],
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_mount_source_unavailable' },
    });
    expect(quota.setLimit).not.toHaveBeenCalled();
    expect(docker.allocateNextIp).not.toHaveBeenCalled();
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('fails closed and keeps a container stopped when the canonical remote path has the wrong physical mount', async () => {
    const stoppedInfo = inspectInfo({
      State: { Running: false, Status: 'exited', StartedAt: 'stopped-token', Pid: 0 },
    });
    const { handler, docker, remoteFsMounter } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer: vi.fn().mockResolvedValue(stoppedInfo),
    }, {}, {}, {
      inspectSource: vi.fn().mockReturnValue({
        sourceId: 'remote-a',
        kind: 'remote',
        root: '/mnt/remote-fs/remote-a',
        identity: 'remote:nfs:identity-a',
        configured: true,
        exists: true,
        isDirectory: true,
        mounted: true,
        fsType: 'nfs4',
        ready: true,
        device: '1',
      }),
    }, {
      getSpec: vi.fn().mockReturnValue({
        id: 'remote-a',
        hostMountPoint: '/mnt/remote-fs/remote-a',
        options: 'ro',
        params: {
          type: 'nfs',
          nfsServer: 'expected.internal',
          exportPath: '/expected',
          version: '4.2',
        },
      }),
      verifyMounted: vi.fn().mockResolvedValue(false),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerStart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      mounts: [{
        sourceId: 'remote-a',
        resourceId: 'resource-a',
        sourceIdentity: 'remote:nfs:identity-a',
        containerPath: '/workspace',
      }],
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_remote_mount_unavailable' },
    });
    expect(remoteFsMounter.verifyMounted).toHaveBeenCalledTimes(1);
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('re-enters an existing create target without creating a second runtime', async () => {
    const { handler, docker } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
      ]),
    });
    const payload = createPayload();

    const first = await handler.ensure(AgentTaskKind.ContainerCreate, payload);
    await handler.verify(AgentTaskKind.ContainerCreate, payload, first);
    const second = await handler.ensure(AgentTaskKind.ContainerCreate, payload);
    await handler.verify(AgentTaskKind.ContainerCreate, payload, second);

    expect(first).toMatchObject({ runtimeId: 'runtime-a', runtimeSpecHash: SPEC_HASH });
    expect(second).toMatchObject({ runtimeId: 'runtime-a', runtimeSpecHash: SPEC_HASH });
    expect(docker.createContainer).not.toHaveBeenCalled();
  });

  it('repeats start and stop as convergent state checks instead of duplicate events', async () => {
    const running = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
    });
    const startPayload = {
      containerId: 'container-a', runtimeId: 'runtime-a', ...powerQuota, mounts: [],
    };
    for (let index = 0; index < 2; index += 1) {
      const result = await running.handler.ensure(AgentTaskKind.ContainerStart, startPayload);
      await running.handler.verify(AgentTaskKind.ContainerStart, startPayload, result);
    }
    expect(running.docker.startContainer).not.toHaveBeenCalled();

    const stoppedInfo = inspectInfo({
      State: { Running: false, Status: 'exited', StartedAt: 'stopped-token', Pid: 0 },
    });
    const stopped = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer: vi.fn().mockResolvedValue(stoppedInfo),
    });
    const stopPayload = { containerId: 'container-a', runtimeId: 'runtime-a' };
    for (let index = 0; index < 2; index += 1) {
      const result = await stopped.handler.ensure(AgentTaskKind.ContainerStop, stopPayload);
      await stopped.handler.verify(AgentTaskKind.ContainerStop, stopPayload, result);
    }
    expect(stopped.docker.stopContainer).not.toHaveBeenCalled();
  });

  it('keeps stop verification incomplete while the runtime is still running', async () => {
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
    });
    const payload = { containerId: 'container-a', runtimeId: 'runtime-a' };

    await expect(handler.verify(AgentTaskKind.ContainerStop, payload, {
      containerId: 'container-a', runtimeId: 'runtime-a',
    })).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'container_not_stopped' },
    });
  });

  it('separates the expected container identity from drifted hinted-runtime labels', async () => {
    const driftedLabels = labels('container-other');
    const { handler, docker } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([]),
      inspectContainer: vi.fn().mockResolvedValue(inspectInfo({
        Config: { Labels: driftedLabels },
      })),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerStop, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_identity_mismatch' },
      observed: {
        expectedContainerId: 'container-a',
        containerId: 'container-other',
        runtimeId: 'runtime-a',
        applied: false,
      },
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  it('reports the exact expected runtime identity when a power target is absent', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const { handler, docker } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([]),
      inspectContainer: vi.fn().mockRejectedValue(notFound),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerStop, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_absent' },
      observed: {
        containerId: 'container-a',
        expectedRuntimeId: 'runtime-a',
        present: false,
      },
    });
    expect(docker.stopContainer).not.toHaveBeenCalled();
  });

  it('repeats matching native mount observation and SSH ensures without physical mutation', async () => {
    const { handler, dropbear } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer: vi.fn().mockResolvedValue(inspectInfo({
        State: { Running: true, Status: 'running', StartedAt: 'token', Pid: 123 },
        Mounts: [{ Type: 'bind', Source: '/tmp', Destination: '/workspace' }],
      })),
    });
    const mountPayload = {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      mounts: [{
        sourceId: 'disk-a',
        resourceId: 'resource-a',
        sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/workspace',
      }],
    };
    for (let index = 0; index < 2; index += 1) {
      const result = await handler.ensure(AgentTaskKind.ContainerStart, mountPayload);
      await handler.verify(AgentTaskKind.ContainerStart, mountPayload, result);
    }

    const sshPayload = { containerId: 'container-a', runtimeId: 'runtime-a', enabled: false };
    for (let index = 0; index < 2; index += 1) {
      const result = await handler.ensure(AgentTaskKind.ContainerSshEnsure, sshPayload);
      await handler.verify(AgentTaskKind.ContainerSshEnsure, sshPayload, result);
    }
    expect(dropbear.reconcileContainerSsh).toHaveBeenCalledTimes(2);
  });

  it('stops and freshly confirms a running start target after mount convergence fails', async () => {
    let running = true;
    const inspectContainer = vi.fn().mockImplementation(async () => inspectInfo({
      State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: 'token', Pid: running ? 123 : 0 },
      Mounts: [{ Type: 'bind', Source: '/var/tmp', Destination: '/workspace' }],
    }));
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      stopContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerStart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/workspace',
      }],
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_mounts_not_converged' },
      observed: { safetyRollback: { running: false } },
    });
    expect(stopContainer).toHaveBeenCalledOnce();
    expect(inspectContainer.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps the task incomplete when a safety stop cannot be confirmed', async () => {
    const stopContainer = vi.fn().mockResolvedValue(undefined);
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer: vi.fn().mockResolvedValue(inspectInfo({
        Mounts: [{ Type: 'bind', Source: '/var/tmp', Destination: '/workspace' }],
      })),
      stopContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerStart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/workspace',
      }],
    })).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'container_safety_stop_unconfirmed' },
    });
    expect(stopContainer).toHaveBeenCalledOnce();
  });

  it('never starts a create target when quota path convergence fails', async () => {
    let running = false;
    const inspectContainer = vi.fn().mockImplementation(async () => inspectInfo({
      State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: 'create-token', Pid: running ? 123 : 0 },
    }));
    const startContainer = vi.fn().mockImplementation(async () => { running = true; });
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      startContainer,
      stopContainer,
    }, {
      addPathToProject: vi.fn().mockRejectedValue(new Error('quota apply failed')),
      inspectPathAssignment: vi.fn().mockResolvedValue({ assigned: false }),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, createPayload())).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_quota_apply_failed' },
      observed: { safetyRollback: { running: false } },
    });
    expect(startContainer).not.toHaveBeenCalled();
    expect(stopContainer).not.toHaveBeenCalled();
  });

  it('keeps a shared quota partial write pending after stopping the runtime', async () => {
    let running = true;
    const inspectContainer = vi.fn().mockImplementation(async () => inspectInfo({
      State: {
        Running: running,
        Status: running ? 'running' : 'exited',
        StartedAt: 'create-token',
        Pid: running ? 123 : 0,
      },
    }));
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const { handler, docker } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      stopContainer,
    }, {
      setLimit: vi.fn().mockRejectedValue(new Error('second XFS root rejected the write')),
      getUsageForUser: vi.fn().mockRejectedValue(new Error('hard limits differ across roots')),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, createPayload())).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: {
        code: 'container_shared_quota_incomplete',
        details: { safetyRollback: { running: false } },
      },
    });
    expect(stopContainer).toHaveBeenCalledOnce();
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('stops a running start target before repairing writable-layer quota assignments', async () => {
    let running = true;
    let repaired = false;
    const inspectContainer = vi.fn().mockImplementation(async () => inspectInfo({
      State: {
        Running: running,
        Status: running ? 'running' : 'exited',
        StartedAt: 'start-token',
        Pid: running ? 123 : 0,
      },
    }));
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const startContainer = vi.fn().mockImplementation(async () => { running = true; });
    const addPathToProject = vi.fn().mockImplementation(async () => { repaired = true; });
    const inspectPathAssignment = vi.fn().mockImplementation(async () => ({ assigned: repaired }));
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      stopContainer,
      startContainer,
    }, { addPathToProject, inspectPathAssignment });

    await expect(handler.ensure(AgentTaskKind.ContainerStart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      mounts: [],
    })).resolves.toMatchObject({ containerId: 'container-a', runtimeId: 'runtime-a' });

    expect(stopContainer).toHaveBeenCalledOnce();
    expect(addPathToProject).toHaveBeenCalledTimes(2);
    expect(startContainer).toHaveBeenCalledOnce();
    expect(stopContainer.mock.invocationCallOrder[0]).toBeLessThan(addPathToProject.mock.invocationCallOrder[0]);
    expect(addPathToProject.mock.invocationCallOrder[1]).toBeLessThan(startContainer.mock.invocationCallOrder[0]);
  });

  it('refuses restart before Docker mutation when the immutable mount set drifted', async () => {
    let running = true;
    let startedAt = 'baseline-token';
    const inspectContainer = vi.fn().mockImplementation(async () => inspectInfo({
      State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: startedAt, Pid: running ? 123 : 0 },
      Mounts: [{ Type: 'bind', Source: '/var/tmp', Destination: '/workspace' }],
    }));
    const restartContainer = vi.fn().mockImplementation(async () => { startedAt = 'restarted-token'; });
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      restartContainer,
      stopContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerRestart, {
      containerId: 'container-a', runtimeId: 'runtime-a', baselineStartedAt: 'baseline-token',
      ...powerQuota,
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        containerPath: '/workspace',
      }],
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_mounts_not_converged' },
      observed: { safetyRollback: { running: false } },
    });
    expect(restartContainer).not.toHaveBeenCalled();
    expect(stopContainer).toHaveBeenCalledOnce();
  });

  it('stops and confirms the container when standalone SSH ensure fails', async () => {
    let running = true;
    const inspectContainer = vi.fn().mockImplementation(async () => inspectInfo({
      State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: 'token', Pid: running ? 123 : 0 },
    }));
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      stopContainer,
    }, {}, {
      reconcileContainerSsh: vi.fn().mockRejectedValue(new Error('ssh setup failed')),
    });
    const payload = {
      containerId: 'container-a', runtimeId: 'runtime-a', enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA platform@example', internalKeyGeneration: 1,
    };

    await expect(handler.ensure(AgentTaskKind.ContainerSshEnsure, payload)).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_ssh_incomplete' },
      observed: { safetyRollback: { running: false } },
    });
    expect(stopContainer).toHaveBeenCalledOnce();
  });

  it('terminally reports an SSH task whose exec fence already rolled the runtime back', async () => {
    const inspectContainer = vi.fn().mockResolvedValue(inspectInfo({
      State: { Running: false, Status: 'exited', StartedAt: 'token', Pid: 0 },
    }));
    const stopContainer = vi.fn();
    const reconcileContainerSsh = vi.fn();
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer,
      stopContainer,
    }, {}, { reconcileContainerSsh });
    const payload = {
      containerId: 'container-a', runtimeId: 'runtime-a', enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA platform@example', internalKeyGeneration: 1,
    };

    await expect(handler.ensure(AgentTaskKind.ContainerSshEnsure, payload)).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_ssh_runtime_stopped' },
      observed: { applied: false, safetyRollback: { running: false } },
    });
    expect(reconcileContainerSsh).not.toHaveBeenCalled();
    expect(stopContainer).not.toHaveBeenCalled();
  });

  it('stops and confirms the container when standalone SSH verification fails', async () => {
    let running = true;
    const stopContainer = vi.fn().mockImplementation(async () => { running = false; });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([{ Id: 'runtime-a', Labels: labels() }]),
      inspectContainer: vi.fn().mockImplementation(async () => inspectInfo({
        State: { Running: running, Status: running ? 'running' : 'exited', StartedAt: 'token', Pid: running ? 123 : 0 },
      })),
      stopContainer,
    });
    const payload = {
      containerId: 'container-a', runtimeId: 'runtime-a', enabled: true,
      internalPublicKey: 'ssh-ed25519 AAAA platform@example', internalKeyGeneration: 1,
    };

    await expect(handler.verify(AgentTaskKind.ContainerSshEnsure, payload, {
      containerId: 'container-a', runtimeId: 'runtime-a', ssh: {},
    })).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_ssh_not_converged' },
      observed: { safetyRollback: { running: false } },
    });
    expect(stopContainer).toHaveBeenCalledOnce();
  });

  it('fails closed with every runtime id when duplicate managed labels exist', async () => {
    const { handler, quota } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
        { Id: 'runtime-b', Labels: labels() },
      ]),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, createPayload())).rejects.toMatchObject({
      name: ManagedTaskError.name,
      observed: { runtimeIds: ['runtime-a', 'runtime-b'] },
    });
    expect(quota.setLimit).not.toHaveBeenCalled();
  });

  it('reports a running malformed claimant as terminal no-touch evidence', async () => {
    const invalidLabels = { ...labels(), [LABEL.SERVER_ID]: 'server-other' };
    const stopContainer = vi.fn();
    const removeContainer = vi.fn();
    const { handler, quota } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: invalidLabels },
      ]),
      inspectContainer: vi.fn().mockResolvedValue(inspectInfo({
        Config: { Labels: invalidLabels },
        State: { Running: true, Status: 'running', StartedAt: 'token', Pid: 123 },
      })),
      stopContainer,
      removeContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, createPayload())).rejects.toMatchObject({
      name: ManagedTaskError.name,
      taskError: { code: 'container_identity_mismatch' },
      observed: {
        expectedContainerId: 'container-a',
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        running: true,
        applied: false,
      },
    });
    expect(stopContainer).not.toHaveBeenCalled();
    expect(removeContainer).not.toHaveBeenCalled();
    expect(quota.setLimit).not.toHaveBeenCalled();
  });

  it('does not adopt a single runtime whose immutable spec hash differs', async () => {
    const staleSpecHash = 'c'.repeat(64);
    const inspect = inspectInfo({
      Config: { Labels: labels('container-a', staleSpecHash) },
      State: {
        Running: false,
        Status: 'exited',
        StartedAt: '2026-07-15T00:00:00.000000000Z',
        Pid: 0,
      },
    });
    const { handler, quota } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels('container-a', staleSpecHash) },
      ]),
      inspectContainer: vi.fn().mockResolvedValue(inspect),
      runtimeSpecHash: vi.fn().mockReturnValue('b'.repeat(64)),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerCreate, createPayload())).rejects.toMatchObject({
      name: ManagedTaskError.name,
      observed: {
        runtimeId: 'runtime-a',
        running: false,
        runtimeSpecHash: staleSpecHash,
        mounts: [],
        ssh: { enabled: false, status: 'disabled' },
      },
    });
    expect(quota.setLimit).not.toHaveBeenCalled();
  });

  it('uses Backend baselineStartedAt to skip a restart that already took effect', async () => {
    const restartContainer = vi.fn();
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
      ]),
      restartContainer,
    });

    const payload = {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      baselineStartedAt: '2026-07-15T01:00:00.000000000Z',
      mounts: [],
    };
    await expect(handler.ensure(AgentTaskKind.ContainerRestart, payload)).resolves.toMatchObject({
      runtimeId: 'runtime-a',
      startedAt: '2026-07-15T01:00:01.000000000Z',
    });
    await expect(handler.ensure(AgentTaskKind.ContainerRestart, payload)).resolves.toMatchObject({
      runtimeId: 'runtime-a',
      startedAt: '2026-07-15T01:00:01.000000000Z',
    });
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it('accepts a restart that took effect before an explicit Docker error response returned', async () => {
    const before = inspectInfo({
      State: {
        Running: true,
        Status: 'running',
        StartedAt: '2026-07-15T01:00:00.000000000Z',
        Pid: 0,
      },
    });
    const after = inspectInfo();
    const inspectContainer = vi.fn()
      // Immutable mount observation happens before the restart decision.
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);
    const restartContainer = vi.fn().mockRejectedValue(
      Object.assign(new Error('Docker restart failed'), { statusCode: 500 }),
    );
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
      ]),
      inspectContainer,
      restartContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerRestart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      baselineStartedAt: '2026-07-15T01:00:00.000000000Z',
      mounts: [],
    })).resolves.toMatchObject({
      runtimeId: 'runtime-a',
      startedAt: '2026-07-15T01:00:01.000000000Z',
    });
    expect(restartContainer).toHaveBeenCalledOnce();
  });

  it('treats StartedAt as an opaque observation token rather than an ordered clock', async () => {
    const restartContainer = vi.fn();
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
      ]),
      inspectContainer: vi.fn().mockResolvedValue(inspectInfo({
        State: {
          Running: true,
          Status: 'running',
          StartedAt: 'opaque-current-token',
          Pid: 0,
        },
      })),
      restartContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerRestart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      baselineStartedAt: 'z-opaque-baseline-token',
      mounts: [],
    })).resolves.toMatchObject({ startedAt: 'opaque-current-token' });
    expect(restartContainer).not.toHaveBeenCalled();
  });

  it('keeps restart pending when Docker errors and the fresh token is unchanged', async () => {
    const unchanged = inspectInfo({
      State: {
        Running: true,
        Status: 'running',
        StartedAt: 'same-token',
        Pid: 0,
      },
    });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
      ]),
      inspectContainer: vi.fn().mockResolvedValue(unchanged),
      restartContainer: vi.fn().mockRejectedValue(new Error('socket closed after restart request')),
    });

    await expect(handler.ensure(AgentTaskKind.ContainerRestart, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      ...powerQuota,
      baselineStartedAt: 'same-token',
      mounts: [],
    })).rejects.toBeInstanceOf(IncompleteTaskError);
  });

  it('refuses deletion before Docker removal when persisted quota recovery paths are incomplete', async () => {
    const removeContainer = vi.fn();
    const stopped = inspectInfo({
      State: {
        Running: false,
        Status: 'exited',
        StartedAt: '2026-07-15T01:00:01.000000000Z',
        Pid: 0,
      },
    });
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-a', Labels: labels() },
      ]),
      inspectContainer: vi.fn()
        .mockResolvedValueOnce(inspectInfo())
        .mockResolvedValue(stopped),
      removeContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerDelete, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      serverId: config.serverId,
      specGeneration: '1',
      runtimeSpecHash: SPEC_HASH,
      numericOwnerId: 7,
      quotaPaths: ['/var/lib/nyabase-docker/overlay/upper'],
    })).rejects.toMatchObject({
      name: 'ZodError',
    });
    expect(removeContainer).not.toHaveBeenCalled();
  });

  it('never reports an unbound delete successful while any product-labelled runtime remains', async () => {
    const removeContainer = vi.fn();
    const { handler } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([
        { Id: 'runtime-residual-a', Labels: labels() },
        { Id: 'runtime-residual-b', Labels: labels() },
      ]),
      removeContainer,
    });

    await expect(handler.ensure(AgentTaskKind.ContainerDelete, {
      containerId: 'container-a',
      runtimeId: null,
      serverId: config.serverId,
      specGeneration: null,
      runtimeSpecHash: null,
      numericOwnerId: 7,
      quotaPaths: [],
    })).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: {
        code: 'container_delete_unbound_runtime_present',
        details: {
          containerId: 'container-a',
          expectedRuntimeId: null,
          runtimeIds: ['runtime-residual-a', 'runtime-residual-b'],
        },
      },
    });
    expect(removeContainer).not.toHaveBeenCalled();
  });

  it('rolls forward quota registration cleanup after Docker is already absent', async () => {
    const registrations = new Map<string, number>();
    const { handler, docker } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([]),
      inspectContainer: vi.fn().mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 })),
    }, {
      inspectExactPathRegistration: vi.fn((quotaPath: string) => ({
        path: quotaPath,
        projectId: registrations.get(quotaPath) ?? null,
      })),
      removeExactPathRegistration: vi.fn((quotaPath: string) => {
        const projectId = registrations.get(quotaPath) ?? null;
        registrations.delete(quotaPath);
        return { path: quotaPath, projectId };
      }),
    });
    const quotaPaths = [
      '/var/lib/nyabase-docker/overlay/upper',
      '/var/lib/nyabase-docker/overlay/work',
    ];
    for (const quotaPath of quotaPaths) registrations.set(quotaPath, 10007);

    const payload = {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      serverId: config.serverId,
      specGeneration: '1',
      runtimeSpecHash: SPEC_HASH,
      numericOwnerId: 7,
      quotaPaths,
    };
    await expect(handler.ensure(AgentTaskKind.ContainerDelete, payload)).resolves.toEqual({
      containerId: 'container-a',
      runtimeId: null,
      quotaPaths,
    });
    await expect(handler.ensure(AgentTaskKind.ContainerDelete, payload)).resolves.toEqual({
      containerId: 'container-a',
      runtimeId: null,
      quotaPaths,
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(registrations.size).toBe(0);
  });

  it('keeps normal deletion pending when an exact registration belongs to another project', async () => {
    const notFound = Object.assign(new Error('not found'), { statusCode: 404 });
    const { handler, docker, quota } = makeHandler({
      listNyabaseContainers: vi.fn().mockResolvedValue([]),
      inspectContainer: vi.fn().mockRejectedValue(notFound),
    }, {
      inspectExactPathRegistration: vi.fn((quotaPath: string) => ({
        path: quotaPath,
        projectId: 10008,
      })),
    });
    const quotaPaths = [
      '/var/lib/nyabase-docker/overlay/upper',
      '/var/lib/nyabase-docker/overlay/work',
    ];

    await expect(handler.ensure(AgentTaskKind.ContainerDelete, {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      serverId: config.serverId,
      specGeneration: '1',
      runtimeSpecHash: SPEC_HASH,
      numericOwnerId: 7,
      quotaPaths,
    })).rejects.toMatchObject({
      name: IncompleteTaskError.name,
      taskError: { code: 'container_runtime_cleanup_registration_owner_mismatch' },
    });
    expect(docker.removeContainer).not.toHaveBeenCalled();
    expect(quota.removeExactPathRegistration).not.toHaveBeenCalled();
  });
});

function createPayload() {
  return {
    containerId: 'container-a',
    specGeneration: 1,
    quotaGeneration: 1,
    dockerRoot: config.dockerRoot,
    ownerId: 'owner-a',
    numericOwnerId: 7,
    imageDockerRef: 'ubuntu:24.04',
    imageDockerId: 'sha256:image-a',
    imageId: 'image-a',
    assignedIp: '10.0.0.2',
    name: 'work',
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 2048,
    mounts: [],
  };
}
