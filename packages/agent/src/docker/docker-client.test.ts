import { describe, it, expect, vi } from 'vitest';
import Dockerode from 'dockerode';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';
import {
  DOCKER_READ_DEADLINES,
  DockerClient,
  DockerMutationDeadlineError,
  DockerObservationAmbiguityError,
  DockerMutationTransportError,
  DockerTimeoutError,
  MANAGEMENT_EXEC_OUTPUT_LIMIT_BYTES,
  MAX_EXEC_STDIN_BUFFERED_BYTES,
  ManagementExecOutputLimitError,
  hashContainerRuntimeSpec,
  withAbortableDockerRead,
  withTimeout,
} from './docker-client.js';
import type { AgentConfig } from '../config.js';
import {
  LABEL,
  NYABASE_NETWORK,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
} from '@nyabase/common';
import { PassThrough } from 'stream';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('withTimeout', () => {
  it('resolves with the inner value when fast enough', async () => {
    const v = await withTimeout(Promise.resolve('ok'), 50, 'fast');
    expect(v).toBe('ok');
  });

  it('rejects with DockerTimeoutError when the inner promise stalls', async () => {
    const stalled = new Promise<never>(() => { /* never resolves */ });
    await expect(withTimeout(stalled, 20, 'stall')).rejects.toBeInstanceOf(DockerTimeoutError);
  });

  it('propagates the underlying rejection without wrapping', async () => {
    const original = new Error('boom');
    await expect(withTimeout(Promise.reject(original), 50, 'boom')).rejects.toBe(original);
  });

  it('clears the internal timer on success so the process does not hang', async () => {
    // Indirect check: run many fast ops in series — if timers leaked, vitest
    // would hold the event loop open at the end of the test file.
    for (let i = 0; i < 50; i++) {
      await withTimeout(Promise.resolve(i), 1_000, `op-${i}`);
    }
    expect(true).toBe(true);
  });

  it('carries the operation label on the error', async () => {
    const stalled = new Promise<never>(() => {});
    try {
      await withTimeout(stalled, 5, 'mylabel');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DockerTimeoutError);
      expect((e as DockerTimeoutError).op).toBe('mylabel');
      expect((e as DockerTimeoutError).timeoutMs).toBe(5);
      expect((e as DockerTimeoutError).ambiguous).toBe(true);
    }
  });
});

describe('DockerClient Docker label handling', () => {
  it('keeps a non-root runtime user while SSH management uses uid 0 and interactive exec inherits it', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-nonroot' });
    const execConfigs: Array<Record<string, unknown>> = [];
    const streams: PassThrough[] = [];
    const managementInput: Buffer[] = [];
    const execFactory = vi.fn().mockImplementation(async (config: Record<string, unknown>) => {
      execConfigs.push(config);
      const stream = new PassThrough();
      streams.push(stream);
      if (config.AttachStdin) stream.on('data', (chunk) => managementInput.push(Buffer.from(chunk)));
      return {
        start: vi.fn().mockResolvedValue(stream),
        inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: 0, Pid: 0 }),
        resize: vi.fn().mockResolvedValue(undefined),
      };
    });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
        getContainer: () => ({ exec: execFactory }),
        modem: {
          demuxStream: (stream: PassThrough, stdout: NodeJS.WritableStream) => {
            stream.on('data', (chunk) => stdout.write(chunk));
          },
        },
      },
    });

    await client.createContainer(runtimeSpec({
      runtimeOverrides: { uid: 1001, entrypoint: null, cmd: null, init: false },
    }));
    await client.putManagementFile('docker-nonroot', '/root/.ssh/key.tmp', Buffer.from('managed'), 0o600);
    const interactive = await client.exec(
      'docker-nonroot',
      ['/bin/sh'],
      true,
      () => {},
      () => {},
    );

    expect(createContainer.mock.calls[0][0]).toMatchObject({ User: '1001' });
    expect(execConfigs[0]).toMatchObject({
      User: '0',
      AttachStdin: true,
      Cmd: expect.arrayContaining(['/root/.ssh/key.tmp']),
    });
    expect(Buffer.concat(managementInput).toString('utf8')).toContain('managed');
    expect(execConfigs[1].User).toBeUndefined();
    expect(execConfigs[1]).toMatchObject({ AttachStdin: true, Cmd: ['/bin/sh'] });

    interactive.kill();
    for (const stream of streams) stream.destroy();
  });

  it('writes identity/generation labels only at container create', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await expect(client.createContainer({
      specGeneration: 7,
      name: 'work',
      imageRef: 'ubuntu:22.04',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      containerId: 'container-a',
      ownerId: 'user-a',
      imageId: 'image-a',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      serverId: 'server-a',
      mounts: [{
        sourceId: 'disk-a', resourceId: 'resource-a', sourceIdentity: 'local:xfs:uuid-a',
        hostPath: '/data/work', containerPath: '/workspace',
      }],
    })).resolves.toBe('docker-created');

    const labels = createContainer.mock.calls[0][0].Labels as Record<string, string>;
    expect(labels).toMatchObject({
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '7',
      [LABEL.RUNTIME_SPEC_HASH]: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(labels['nyabase.ssh_server_enabled']).toBeUndefined();
    expect(labels['nyabase.owner_id']).toBeUndefined();
    expect(labels['nyabase.ssh_user']).toBeUndefined();
    expect(labels['nyabase.ssh_uid']).toBeUndefined();
    expect(createContainer.mock.calls[0][0].HostConfig).toMatchObject({
      RestartPolicy: { Name: 'no' },
      Mounts: [{ Type: 'bind', Source: '/data/work', Target: '/workspace', ReadOnly: false }],
    });
  });

  it('hashes the complete runtime spec deterministically and normalizes GPU order', () => {
    const spec = {
      specGeneration: 1,
      name: 'work',
      imageRef: 'ubuntu:24.04',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [2, 0],
      ip: '10.0.0.2',
      containerId: 'container-a',
      ownerId: 'user-a',
      imageId: 'image-a',
      runtimeOverrides: { uid: 1000, entrypoint: null, cmd: ['sleep', '1'], init: true },
      serverId: 'server-a',
      mounts: [],
    };

    expect(hashContainerRuntimeSpec(spec)).toBe(hashContainerRuntimeSpec({
      ...spec,
      gpuIndices: [0, 2],
    }));
    expect(hashContainerRuntimeSpec({ ...spec, memBytes: 2048 })).not.toBe(hashContainerRuntimeSpec(spec));
    expect(hashContainerRuntimeSpec({ ...spec, specGeneration: 2 })).not.toBe(hashContainerRuntimeSpec(spec));
  });

  it('requests NVIDIA devices when gpuIndices are provided', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await client.createContainer({
      specGeneration: 1,
      name: 'gpu-work',
      imageRef: 'nvidia/cuda:latest',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [0, 2],
      ip: '10.0.0.2',
      containerId: 'container-gpu',
      ownerId: 'user-gpu',
      imageId: 'image-gpu',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      serverId: 'server-gpu',
      mounts: [],
    });

    const spec = createContainer.mock.calls[0][0];
    expect(spec.Env).toContain('NVIDIA_VISIBLE_DEVICES=0,2');
    expect(spec.Env).toContain('NVIDIA_DRIVER_CAPABILITIES=all');
    expect(spec.HostConfig).toMatchObject({
      Runtime: 'nvidia',
      DeviceRequests: [{
        Driver: 'nvidia',
        DeviceIDs: ['0', '2'],
        Capabilities: [['gpu']],
      }],
    });
  });

  it('applies image runtime overrides to Docker create options', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await client.createContainer({
      specGeneration: 1,
      name: 'override-work',
      imageRef: 'ubuntu:24.04',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      containerId: 'container-override',
      ownerId: 'user-override',
      imageId: 'image-override',
      runtimeOverrides: {
        uid: 1000,
        entrypoint: ['/entrypoint'],
        cmd: ['sleep', 'infinity'],
        init: true,
      },
      serverId: 'server-override',
      mounts: [],
    });

    expect(createContainer.mock.calls[0][0]).toMatchObject({
      User: '1000',
      Entrypoint: ['/entrypoint'],
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        Init: true,
      },
    });
  });

  it('sets the nyabase Docker limit cgroup parent when host resource limits are enabled', async () => {
    const client = new DockerClient({
      ...makeConfig(),
      dockerResourceLimit: { enabled: true },
    });
    const createContainer = vi.fn().mockResolvedValue({ id: 'docker-created' });
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer,
      },
    });

    await client.createContainer({
      specGeneration: 1,
      name: 'limited-work',
      imageRef: 'ubuntu:24.04',
      cpuMillis: 1000,
      memBytes: 1024,
      gpuIndices: [],
      ip: '10.0.0.2',
      containerId: 'container-limited',
      ownerId: 'user-limited',
      imageId: 'image-limited',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      serverId: 'server-limited',
      mounts: [],
    });

    expect(createContainer.mock.calls[0][0].HostConfig).toMatchObject({
      CgroupParent: 'nyabase-docker-limit.slice',
    });
  });

  it('parses runtime IP from Docker network info for state reports', () => {
    const client = new DockerClient(makeConfig());
    const runtime = client.parseContainerRuntimeObservation({
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    }, {
      NetworkSettings: {
        Networks: {
          nyabase_net: { IPAddress: '10.0.0.2' },
        },
      },
    } as never);

    expect(runtime).toMatchObject({ ip: '10.0.0.2' });
  });

  it('uses the retained static IPAM address for a stopped managed runtime', () => {
    const client = new DockerClient(makeConfig());
    const runtime = client.parseContainerRuntimeObservation({
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    }, {
      NetworkSettings: {
        Networks: {
          nyabase_net: {
            IPAddress: '',
            IPAMConfig: { IPv4Address: '10.0.0.2' },
          },
        },
      },
    } as never);

    expect(runtime).toMatchObject({ ip: '10.0.0.2' });
  });

  it('refuses a fallback IP from a foreign Docker network', () => {
    const client = new DockerClient(makeConfig());
    const runtime = client.parseContainerRuntimeObservation({
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: 'container-a',
      [LABEL.SERVER_ID]: 'server-a',
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    }, {
      NetworkSettings: {
        Networks: {
          bridge: { IPAddress: '172.17.0.2' },
        },
      },
    });

    expect(runtime).toBeNull();
  });

  it('collects an unfiltered all-container inventory for absent-runtime path proofs', async () => {
    const client = new DockerClient(makeConfig());
    const listContainers = vi.fn().mockResolvedValue([{ Id: 'runtime-a' }]);
    Object.defineProperty(client, 'docker', { value: { listContainers } });

    await expect(client.listAllContainers()).resolves.toEqual([{ Id: 'runtime-a' }]);
    expect(listContainers).toHaveBeenCalledWith({
      all: true,
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('derives the Docker runtime name only from immutable container identity', async () => {
    const client = new DockerClient(makeConfig());
    const createContainer = vi.fn()
      .mockResolvedValueOnce({ id: 'docker-a' })
      .mockResolvedValueOnce({ id: 'docker-b' });
    Object.defineProperty(client, 'docker', { value: { createContainer } });

    await client.createContainer(runtimeSpec({ containerId: 'container-a', name: 'same-name' }));
    await client.createContainer(runtimeSpec({ containerId: 'container-b', name: 'same-name' }));

    const firstName = createContainer.mock.calls[0][0].name;
    const secondName = createContainer.mock.calls[1][0].name;
    expect(firstName).toMatch(/^nyabase-[a-f0-9]{64}$/);
    expect(secondName).toMatch(/^nyabase-[a-f0-9]{64}$/);
    expect(firstName).not.toBe(secondName);
    expect(firstName).not.toContain('same-name');
  });
});

describe('DockerClient stateless process recovery', () => {
  it('stops every running managed runtime and freshly proves all runtimes stopped twice', async () => {
    const runningId = 'a'.repeat(64);
    const stoppedId = 'b'.repeat(64);
    const running = new Map<string, boolean>([
      [runningId, true],
      [stoppedId, false],
    ]);
    const inspectById = new Map<string, ReturnType<typeof vi.fn>>();
    const killById = new Map<string, ReturnType<typeof vi.fn>>();
    const getContainer = vi.fn((runtimeId: string) => {
      let inspect = inspectById.get(runtimeId);
      if (!inspect) {
        inspect = vi.fn(async () => ({ State: { Running: running.get(runtimeId) } }));
        inspectById.set(runtimeId, inspect);
      }
      let kill = killById.get(runtimeId);
      if (!kill) {
        kill = vi.fn(async () => { running.set(runtimeId, false); });
        killById.set(runtimeId, kill);
      }
      return { inspect, kill };
    });
    const listContainers = vi.fn().mockResolvedValue([
      { Id: runningId },
      { Id: stoppedId },
    ]);
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', { value: { listContainers, getContainer } });

    await expect(client.quiesceManagedContainersForStatelessRecovery())
      .resolves.toBeUndefined();

    expect(listContainers).toHaveBeenCalledTimes(2);
    expect(killById.get(runningId)).toHaveBeenCalledOnce();
    expect(killById.get(stoppedId)).not.toHaveBeenCalled();
    expect(inspectById.get(runningId)).toHaveBeenCalledTimes(3);
    expect(inspectById.get(stoppedId)).toHaveBeenCalledTimes(2);
  });

  it('also stops a managed runtime first observed on the confirmation pass', async () => {
    const firstId = 'c'.repeat(64);
    const lateId = 'd'.repeat(64);
    const running = new Map<string, boolean>([
      [firstId, false],
      [lateId, true],
    ]);
    const killById = new Map<string, ReturnType<typeof vi.fn>>();
    const getContainer = vi.fn((runtimeId: string) => {
      const kill = vi.fn(async () => { running.set(runtimeId, false); });
      killById.set(runtimeId, kill);
      return {
        inspect: vi.fn(async () => ({ State: { Running: running.get(runtimeId) } })),
        kill,
      };
    });
    const listContainers = vi.fn()
      .mockResolvedValueOnce([{ Id: firstId }])
      .mockResolvedValueOnce([{ Id: firstId }, { Id: lateId }]);
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', { value: { listContainers, getContainer } });

    await expect(client.quiesceManagedContainersForStatelessRecovery())
      .resolves.toBeUndefined();

    expect(killById.get(firstId)).not.toHaveBeenCalled();
    expect(killById.get(lateId)).toHaveBeenCalledOnce();
  });

  it('unpauses a recovered managed runtime before killing and proving it stopped', async () => {
    const runtimeId = 'e'.repeat(64);
    let running = true;
    let paused = true;
    const unpause = vi.fn(async () => { paused = false; });
    const kill = vi.fn(async () => {
      if (paused) throw Object.assign(new Error('container is paused'), { statusCode: 409 });
      running = false;
    });
    const inspect = vi.fn(async () => ({ State: { Running: running, Paused: paused } }));
    const listContainers = vi.fn().mockResolvedValue([{ Id: runtimeId }]);
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', {
      value: {
        listContainers,
        getContainer: () => ({ inspect, unpause, kill }),
      },
    });

    await expect(client.quiesceManagedContainersForStatelessRecovery())
      .resolves.toBeUndefined();

    expect(unpause).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenLastCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
  });

  it('refuses an unbounded managed inventory before entering per-runtime work', async () => {
    const listContainers = vi.fn().mockResolvedValue(
      Array.from({ length: MAX_MANAGED_CONTAINERS_PER_AGENT + 1 }, (_, index) => ({
        Id: index.toString(16).padStart(64, '0'),
      })),
    );
    const getContainer = vi.fn();
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', { value: { listContainers, getContainer } });

    await expect(client.quiesceManagedContainersForStatelessRecovery())
      .rejects.toThrow(`exceeds ${MAX_MANAGED_CONTAINERS_PER_AGENT}`);
    expect(getContainer).not.toHaveBeenCalled();
  });
});

describe('DockerClient interactive exec backpressure', () => {
  it('rejects stdin when the Docker stream cannot accept another bounded chunk', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough({ highWaterMark: 1 });
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: 0, Pid: 0 }),
      resize: vi.fn().mockResolvedValue(undefined),
    };
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({ exec: vi.fn().mockResolvedValue(exec) }),
        // Deliberately do not consume the PassThrough readable side.
        modem: { demuxStream: vi.fn() },
      },
    });
    const handles = await client.exec('runtime-a', ['/bin/sh'], false, vi.fn(), vi.fn());

    expect(handles.write(Buffer.alloc(
      Math.min(64 * 1024, MAX_EXEC_STDIN_BUFFERED_BYTES),
      0x61,
    ).toString('base64'))).toBe(false);

    stream.destroy();
  });

  it('runs one Docker resize at a time and keeps only the latest follow-up', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    const first = deferred<void>();
    const resize = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: 0, Pid: 0 }),
      resize,
    };
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({ exec: vi.fn().mockResolvedValue(exec) }),
        modem: { demuxStream: vi.fn() },
      },
    });
    const handles = await client.exec('runtime-a', ['/bin/sh'], true, vi.fn(), vi.fn());

    handles.resize(80, 24);
    for (let index = 0; index < 100; index += 1) {
      handles.resize(100 + index, 40 + index);
    }
    await vi.waitFor(() => expect(resize).toHaveBeenCalledOnce());

    first.resolve(undefined);
    await vi.waitFor(() => expect(resize).toHaveBeenCalledTimes(2));
    expect(resize.mock.calls[1]?.[0]).toEqual({ w: 199, h: 139 });

    stream.destroy();
  });
});

describe('DockerClient interactive exec physical completion barrier', () => {
  it('physically cleans a possibly-started exec before surfacing an HTTP start failure', async () => {
    const client = new DockerClient(makeConfig());
    const startError = Object.assign(new Error('attach failed after launch'), { statusCode: 500 });
    const exec = {
      start: vi.fn().mockRejectedValue(startError),
      inspect: vi.fn().mockResolvedValue({ Running: true, ExitCode: null, Pid: 91 }),
    };
    let containerRunning = true;
    const containerKill = vi.fn(async () => { containerRunning = false; });
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn().mockResolvedValue(exec),
          inspect: vi.fn(async () => ({ State: { Running: containerRunning } })),
          kill: containerKill,
        }),
      },
    });

    await expect(client.exec('runtime-a', ['/bin/sh'], true, vi.fn(), vi.fn()))
      .rejects.toBe(startError);
    expect(exec.inspect).toHaveBeenCalledOnce();
    expect(containerKill).toHaveBeenCalledOnce();
  });

  it('physically cleans the exec before surfacing synchronous demux setup failure', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    const demuxError = new Error('demux setup failed');
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ Running: true, ExitCode: null, Pid: 91 }),
      resize: vi.fn().mockResolvedValue(undefined),
    };
    let containerRunning = true;
    const containerKill = vi.fn(async () => { containerRunning = false; });
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn().mockResolvedValue(exec),
          inspect: vi.fn(async () => ({ State: { Running: containerRunning } })),
          kill: containerKill,
        }),
        modem: { demuxStream: vi.fn(() => { throw demuxError; }) },
      },
    });

    await expect(client.exec('runtime-a', ['/bin/sh'], false, vi.fn(), vi.fn()))
      .rejects.toBe(demuxError);
    expect(containerKill).toHaveBeenCalledOnce();
    expect(stream.destroyed).toBe(true);
  });

  it('reports a natural exit only after fresh stopped state and integer exit code', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ Running: false, ExitCode: 7, Pid: 0 }),
      resize: vi.fn().mockResolvedValue(undefined),
    };
    const containerInspect = vi.fn();
    const containerKill = vi.fn();
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn().mockResolvedValue(exec),
          inspect: containerInspect,
          kill: containerKill,
        }),
        modem: { demuxStream: vi.fn() },
      },
    });
    const onEnd = vi.fn();
    let closeBarrier: Promise<void> | undefined;
    await client.exec(
      'runtime-a', ['/bin/sh'], true, vi.fn(), onEnd,
      (barrier) => { closeBarrier = barrier; },
    );

    stream.end();
    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledWith(7));
    await closeBarrier;
    expect(exec.inspect).toHaveBeenCalledOnce();
    expect(containerInspect).not.toHaveBeenCalled();
    expect(containerKill).not.toHaveBeenCalled();
  });

  it('uses one shared exact-container stop barrier for error-only and explicit close', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ Running: true, ExitCode: null, Pid: 91 }),
      resize: vi.fn().mockResolvedValue(undefined),
    };
    let containerRunning = true;
    let releaseKill!: () => void;
    const killGate = new Promise<void>((resolve) => { releaseKill = resolve; });
    const containerKill = vi.fn(async () => {
      await killGate;
      containerRunning = false;
    });
    const containerInspect = vi.fn(async () => ({ State: { Running: containerRunning } }));
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn().mockResolvedValue(exec),
          inspect: containerInspect,
          kill: containerKill,
        }),
        modem: { demuxStream: vi.fn() },
      },
    });
    const onEnd = vi.fn();
    let eventBarrier: Promise<void> | undefined;
    const handles = await client.exec(
      'runtime-a', ['/bin/sh'], true, vi.fn(), onEnd,
      (barrier) => { eventBarrier = barrier; },
    );

    // An error event is not assumed to be followed by close/end.
    stream.emit('error', new Error('hijack transport lost'));
    await vi.waitFor(() => expect(containerKill).toHaveBeenCalledOnce());
    const explicitBarrier = handles.kill();
    expect(explicitBarrier).toBe(eventBarrier);
    expect(onEnd).not.toHaveBeenCalled();

    releaseKill();
    await explicitBarrier;
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onEnd).toHaveBeenCalledWith(-1);
    expect(containerKill).toHaveBeenCalledOnce();
    expect(containerInspect).toHaveBeenLastCalledWith(expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
  });

  it('aborts a stalled exec observation before rolling back the exact container', async () => {
    vi.useFakeTimers();
    try {
      const client = new DockerClient(makeConfig());
      const stream = new PassThrough();
      let inspectSignal: AbortSignal | undefined;
      const exec = {
        start: vi.fn().mockResolvedValue(stream),
        inspect: vi.fn((options?: { abortSignal?: AbortSignal }) => {
          inspectSignal = options?.abortSignal;
          return new Promise<never>(() => undefined);
        }),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      let containerRunning = true;
      const containerKill = vi.fn(async () => { containerRunning = false; });
      Object.defineProperty(client, 'docker', {
        value: {
          getContainer: () => ({
            exec: vi.fn().mockResolvedValue(exec),
            inspect: vi.fn(async () => ({ State: { Running: containerRunning } })),
            kill: containerKill,
          }),
          modem: { demuxStream: vi.fn() },
        },
      });
      const onEnd = vi.fn();
      const handles = await client.exec('runtime-a', ['/bin/sh'], true, vi.fn(), onEnd);
      const closing = handles.kill();

      await vi.advanceTimersByTimeAsync(DOCKER_READ_DEADLINES.inspect);
      await vi.advanceTimersByTimeAsync(50);
      await closing;

      expect(inspectSignal?.aborted).toBe(true);
      expect(containerKill).toHaveBeenCalledOnce();
      expect(onEnd).toHaveBeenCalledWith(-1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reports EOF or releases close when the container-stop mutation is ambiguous', async () => {
    vi.useFakeTimers();
    try {
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), { fatalHook });
      const stream = new PassThrough();
      const exec = {
        start: vi.fn().mockResolvedValue(stream),
        inspect: vi.fn().mockResolvedValue({ Running: true, ExitCode: null, Pid: 91 }),
        resize: vi.fn().mockResolvedValue(undefined),
      };
      Object.defineProperty(client, 'docker', {
        value: {
          getContainer: () => ({
            exec: vi.fn().mockResolvedValue(exec),
            inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
            kill: vi.fn(() => new Promise<never>(() => undefined)),
          }),
          modem: { demuxStream: vi.fn() },
        },
      });
      const onEnd = vi.fn();
      const handles = await client.exec('runtime-a', ['/bin/sh'], true, vi.fn(), onEnd);
      let settled = false;
      const closing = handles.kill();
      void closing.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(DockerMutationDeadlineError);
      expect(onEnd).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps close pending until an already-admitted resize mutation settles', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    const resizeGate = deferred<void>();
    const exec = {
      start: vi.fn().mockResolvedValue(stream),
      inspect: vi.fn().mockResolvedValue({ Running: true, ExitCode: null, Pid: 91 }),
      resize: vi.fn(() => resizeGate.promise),
    };
    let containerRunning = true;
    const containerKill = vi.fn(async () => { containerRunning = false; });
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn().mockResolvedValue(exec),
          inspect: vi.fn(async () => ({ State: { Running: containerRunning } })),
          kill: containerKill,
        }),
        modem: { demuxStream: vi.fn() },
      },
    });
    const onEnd = vi.fn();
    const handles = await client.exec('runtime-a', ['/bin/sh'], true, vi.fn(), onEnd);
    handles.resize(120, 40);
    await vi.waitFor(() => expect(exec.resize).toHaveBeenCalledOnce());

    let closeSettled = false;
    const closing = handles.kill().then(() => { closeSettled = true; });
    await vi.waitFor(() => expect(containerKill).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(closeSettled).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();

    resizeGate.resolve(undefined);
    await closing;
    expect(onEnd).toHaveBeenCalledOnce();
  });

  it('fail-stops before close can release when an admitted resize is ambiguous', async () => {
    vi.useFakeTimers();
    try {
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), { mutationDeadlineMs: 50, fatalHook });
      const stream = new PassThrough();
      const exec = {
        start: vi.fn().mockResolvedValue(stream),
        inspect: vi.fn().mockResolvedValue({ Running: true, ExitCode: null, Pid: 91 }),
        resize: vi.fn(() => new Promise<never>(() => undefined)),
      };
      let containerRunning = true;
      Object.defineProperty(client, 'docker', {
        value: {
          getContainer: () => ({
            exec: vi.fn().mockResolvedValue(exec),
            inspect: vi.fn(async () => ({ State: { Running: containerRunning } })),
            kill: vi.fn(async () => { containerRunning = false; }),
          }),
          modem: { demuxStream: vi.fn() },
        },
      });
      const onEnd = vi.fn();
      const handles = await client.exec('runtime-a', ['/bin/sh'], true, vi.fn(), onEnd);
      handles.resize(120, 40);
      const closing = handles.kill();
      let settled = false;
      void closing.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(50);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(onEnd).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DockerClient management exec completion barrier', () => {
  it('waits past attach close until Running=false and an integer ExitCode are both observed', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    let running = true;
    let exitCode: number | null = null;
    const inspectExec = vi.fn(async () => ({ Running: running, ExitCode: exitCode, Pid: running ? 91 : 0 }));
    const start = vi.fn(async () => stream);
    const exec = { start, inspect: inspectExec };
    const createExec = vi.fn(async (_config: { Cmd: string[] }) => exec);
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({ exec: createExec }),
        modem: {
          demuxStream: (source: PassThrough, stdout: NodeJS.WritableStream) => {
            source.on('data', (chunk) => stdout.write(chunk));
          },
        },
      },
    });

    let settled = false;
    const result = client.execManagementCapture('docker-a', ['/bin/sh', '-c', 'printf ok'], 1_000);
    void result.finally(() => { settled = true; });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    stream.end(Buffer.from('ok'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    running = false;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    exitCode = 0;
    await expect(result).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(inspectExec.mock.calls.length).toBeGreaterThanOrEqual(3);

    const config = createExec.mock.calls[0]![0];
    expect(config.Cmd.slice(-3)).toEqual(['/bin/sh', '-c', 'printf ok']);
    expect(config.Cmd[2]).toContain('/proc/1/stat');
    expect(config.Cmd[2]).toContain('/run/nyabase-management-exec.lock');
    expect(config.Cmd[2]).toContain('mkdir "$lock" 2>/dev/null || exit "$busy"');
  });

  it('stops the container and proves it stopped when exec inspection times out', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    const inspectExec = vi.fn(() => new Promise<never>(() => {}));
    const exec = { start: vi.fn(async () => stream), inspect: inspectExec };
    let containerRunning = true;
    const inspectContainer = vi.fn(async () => ({ State: { Running: containerRunning } }));
    const kill = vi.fn(async () => { containerRunning = false; });
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn(async () => exec),
          inspect: inspectContainer,
          kill,
        }),
        modem: { demuxStream: () => {} },
      },
    });

    const result = client.execManagementCapture('docker-a', ['/bin/sh', '-c', 'sleep 30'], 600);
    await vi.waitFor(() => expect(exec.start).toHaveBeenCalledOnce());
    stream.end();

    await expect(result).rejects.toBeInstanceOf(DockerTimeoutError);
    expect(kill).toHaveBeenCalledWith({ signal: 'SIGKILL' });
    expect(inspectContainer).toHaveBeenLastCalledWith({
      abortSignal: expect.any(AbortSignal),
    });
    expect(containerRunning).toBe(false);
  });

  it('fail-stops instead of returning when management exec start has no definite response', async () => {
    vi.useFakeTimers();
    try {
      const pendingStart = deferred<NodeJS.ReadWriteStream>();
      const start = vi.fn(() => pendingStart.promise);
      const inspect = vi.fn().mockResolvedValue({ Running: false, ExitCode: null, Pid: 0 });
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), { fatalHook });
      Object.defineProperty(client, 'docker', {
        value: {
          getContainer: () => ({
            exec: vi.fn().mockResolvedValue({ start, inspect }),
          }),
          modem: { demuxStream: vi.fn() },
        },
      });

      let settled = false;
      const result = client.execManagementCapture(
        'runtime-a',
        ['/bin/sh', '-c', 'printf late > /tmp/state'],
        40,
      );
      void result.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(start).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(40);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: 'exec.start(runtime-a)',
      });
      expect(inspect).not.toHaveBeenCalled();
      expect(settled).toBe(false);

      // Even a late physical response cannot make this Agent authorize replay.
      pendingStart.resolve(new PassThrough());
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fail-stops a container kill with no definite response instead of trusting a later inspect', async () => {
    vi.useFakeTimers();
    try {
      const pendingKill = deferred<void>();
      const kill = vi.fn(() => pendingKill.promise);
      const inspect = vi.fn().mockResolvedValue({ State: { Running: true } });
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), { fatalHook });
      Object.defineProperty(client, 'docker', {
        value: { getContainer: () => ({ inspect, kill }) },
      });

      let settled = false;
      const barrier = (client as unknown as {
        stopExactContainerForExecBarrier(dockerId: string, deadlineAt: number): Promise<void>;
      }).stopExactContainerForExecBarrier('runtime-a', Date.now() + 40);
      void barrier.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(kill).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(40);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: 'container.exec-barrier.kill(runtime-a)',
      });
      expect(inspect).toHaveBeenCalledOnce();
      expect(settled).toBe(false);

      pendingKill.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fail-stops the Agent but never stops a workload when a read-only observation exec is ambiguous', async () => {
    const fatalHook = vi.fn();
    const client = new DockerClient(makeConfig(), { fatalHook });
    const stream = new PassThrough();
    const never = () => new Promise<never>(() => {});
    const exec = { start: vi.fn(async () => stream), inspect: vi.fn(never) };
    const kill = vi.fn();
    const inspectContainer = vi.fn(async () => ({ State: { Running: true } }));
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn(async () => exec),
          inspect: inspectContainer,
          kill,
        }),
        modem: { demuxStream: () => {} },
      },
    });

    let settled = false;
    const result = client.execObservationCapture(
      'docker-a',
      ['/bin/sh', '-c', 'sleep 30'],
      400,
    );
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(exec.start).toHaveBeenCalledOnce());
    stream.end();
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce(), { timeout: 1_000 });

    expect(kill).not.toHaveBeenCalled();
    expect(inspectContainer).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(DockerObservationAmbiguityError);
  });

  it('enforces a combined hard output cap before returning and still proves the exec stopped', async () => {
    const client = new DockerClient(makeConfig());
    const stream = new PassThrough();
    let containerRunning = true;
    const exec = {
      start: vi.fn(async () => stream),
      inspect: vi.fn(async () => ({ Running: true, ExitCode: null, Pid: 93 })),
    };
    const kill = vi.fn(async () => { containerRunning = false; });
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn(async () => exec),
          inspect: vi.fn(async () => ({ State: { Running: containerRunning } })),
          kill,
        }),
        modem: {
          demuxStream: (source: PassThrough, stdout: NodeJS.WritableStream) => {
            source.on('data', (chunk) => stdout.write(chunk));
          },
        },
      },
    });

    const result = client.execManagementCapture('docker-a', ['/bin/sh', '-c', 'yes'], 1_000);
    await vi.waitFor(() => expect(exec.start).toHaveBeenCalledOnce());
    stream.write(Buffer.alloc(MANAGEMENT_EXEC_OUTPUT_LIMIT_BYTES + 1, 0x61));

    await expect(result).rejects.toBeInstanceOf(ManagementExecOutputLimitError);
    expect(kill).toHaveBeenCalledOnce();
    expect(containerRunning).toBe(false);
  });

  it('fail-stops and leaves the task pending when container stop cannot be proven', async () => {
    const fatalHook = vi.fn();
    const client = new DockerClient(makeConfig(), { fatalHook });
    const stream = new PassThrough();
    const never = () => new Promise<never>(() => {});
    const exec = {
      start: vi.fn(async () => stream),
      inspect: vi.fn(never),
    };
    Object.defineProperty(client, 'docker', {
      value: {
        getContainer: () => ({
          exec: vi.fn(async () => exec),
          inspect: vi.fn(never),
          kill: vi.fn(never),
        }),
        modem: { demuxStream: () => {} },
      },
    });

    let settled = false;
    const result = client.execManagementCapture('docker-a', ['/bin/sh', '-c', 'sleep 30'], 400);
    void result.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await vi.waitFor(() => expect(exec.start).toHaveBeenCalledOnce());
    stream.end();
    await vi.waitFor(() => expect(fatalHook).toHaveBeenCalledOnce(), { timeout: 1_000 });

    expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(DockerMutationDeadlineError);
    expect(settled).toBe(false);
  });
});

describe('DockerClient physical mutation settlement', () => {
  it('reconciles exactly one label-matched runtime after an explicit Docker conflict response', async () => {
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer: vi.fn().mockRejectedValue(
          Object.assign(new Error('name is already in use'), { statusCode: 409 }),
        ),
        listContainers: vi.fn().mockResolvedValue([{
          Id: 'committed-runtime',
          Labels: {
            [LABEL.MANAGED]: 'true',
            [LABEL.CONTAINER_ID]: 'container-a',
            [LABEL.SERVER_ID]: 'server-a',
            [LABEL.SPEC_GENERATION]: '1',
            [LABEL.RUNTIME_SPEC_HASH]: hashContainerRuntimeSpec(runtimeSpec()),
          },
        }]),
      },
    });

    await expect(client.createContainer(runtimeSpec())).resolves.toBe('committed-runtime');
  });

  it('never adopts a conflict runtime from another durable spec generation', async () => {
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', {
      value: {
        createContainer: vi.fn().mockRejectedValue(
          Object.assign(new Error('name is already in use'), { statusCode: 409 }),
        ),
        listContainers: vi.fn().mockResolvedValue([{
          Id: 'stale-runtime',
          Labels: {
            [LABEL.MANAGED]: 'true',
            [LABEL.CONTAINER_ID]: 'container-a',
            [LABEL.SERVER_ID]: 'server-a',
            [LABEL.SPEC_GENERATION]: '2',
            [LABEL.RUNTIME_SPEC_HASH]: hashContainerRuntimeSpec(runtimeSpec()),
          },
        }]),
      },
    });

    await expect(client.createContainer(runtimeSpec())).rejects.toThrow(/generation\/spec/);
  });

  it.each(['create', 'start', 'restart', 'remove'] as const)(
    'fail-stops a %s transport rejection, leaves both calls pending, and poisons later mutations',
    async (kind) => {
      const transportError = new Error('socket closed before response');
      const fatalHook = vi.fn();
      const fixture = mutationFixture(kind, transportError);
      const client = new DockerClient(makeConfig(), { fatalHook });
      Object.defineProperty(client, 'docker', { value: fixture.docker });

      let firstSettled = false;
      const first = fixture.invoke(client);
      void first.then(
        () => { firstSettled = true; },
        () => { firstSettled = true; },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(fixture.physical).toHaveBeenCalledOnce();
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(DockerMutationTransportError);
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: fixture.operation,
        transportError,
      });
      expect(firstSettled).toBe(false);

      const entryCalls = fixture.entry.mock.calls.length;
      let laterSettled = false;
      const later = client.startContainer('later-runtime');
      void later.then(
        () => { laterSettled = true; },
        () => { laterSettled = true; },
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(fixture.entry).toHaveBeenCalledTimes(entryCalls);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(laterSettled).toBe(false);
    },
  );

  it.each(['create', 'start', 'restart', 'remove'] as const)(
    'propagates an explicit Docker HTTP response for %s without fail-stop',
    async (kind) => {
      const responseError = Object.assign(new Error('Docker rejected mutation'), { statusCode: 500 });
      const fatalHook = vi.fn();
      const fixture = mutationFixture(kind, responseError);
      const client = new DockerClient(makeConfig(), { fatalHook });
      Object.defineProperty(client, 'docker', { value: fixture.docker });

      await expect(fixture.invoke(client)).rejects.toBe(responseError);
      expect(fixture.physical).toHaveBeenCalledOnce();
      expect(fatalHook).not.toHaveBeenCalled();
    },
  );

  it('settles normally before the mutation deadline and cancels fail-stop', async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<{ id: string }>();
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), {
        mutationDeadlineMs: 25,
        fatalHook,
      });
      Object.defineProperty(client, 'docker', {
        value: { createContainer: vi.fn(() => pending.promise) },
      });

      const create = client.createContainer(runtimeSpec());
      pending.resolve({ id: 'runtime-a' });
      await expect(create).resolves.toBe('runtime-a');
      await vi.advanceTimersByTimeAsync(25);
      expect(fatalHook).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fail-stops a never-settling mutation without resolving or allowing retry', async () => {
    vi.useFakeTimers();
    try {
      const restart = deferred<void>();
      const fatalHook = vi.fn();
      const getContainer = vi.fn(() => ({
        restart: () => restart.promise,
        start: vi.fn().mockResolvedValue(undefined),
      }));
      const client = new DockerClient(makeConfig(), { mutationDeadlineMs: 25, fatalHook });
      Object.defineProperty(client, 'docker', {
        value: { getContainer },
      });
      let settled = false;
      const operation = client.restartContainer('runtime-a');
      void operation.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(DockerMutationDeadlineError);
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: 'container.restart(runtime-a)',
        timeoutMs: 25,
      });
      expect(settled).toBe(false);

      // Even if dockerd eventually returns, the timed-out invocation remains
      // unobservable and the poisoned client cannot start another mutation.
      restart.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      const retry = client.startContainer('runtime-a');
      void retry.catch(() => {});
      await Promise.resolve();
      expect(getContainer).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the same fail-stop rule to exec start', async () => {
    vi.useFakeTimers();
    try {
      const startExec = deferred<NodeJS.ReadWriteStream>();
      const start = vi.fn(() => startExec.promise);
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), { mutationDeadlineMs: 25, fatalHook });
      Object.defineProperty(client, 'docker', {
        value: {
          getContainer: vi.fn(() => ({
            exec: vi.fn().mockResolvedValue({ start }),
          })),
        },
      });
      let settled = false;
      const running = client.exec('runtime-a', ['sh'], true, vi.fn(), vi.fn());
      void running.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(start).toHaveBeenCalledOnce();
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DockerClient read deadlines', () => {
  it('bounds image and daemon probes when dockerode never settles', async () => {
    vi.useFakeTimers();
    try {
      const stalled = () => new Promise<never>(() => {});
      const signals: AbortSignal[] = [];
      const capture = (options?: { abortSignal?: AbortSignal }) => {
        if (options?.abortSignal) signals.push(options.abortSignal);
        return stalled();
      };
      const client = new DockerClient(makeConfig());
      Object.defineProperty(client, 'docker', {
        value: {
          getImage: vi.fn(() => ({ inspect: capture })),
          getContainer: vi.fn(() => ({ stats: capture })),
          listContainers: vi.fn(capture),
          listImages: vi.fn(capture),
          ping: vi.fn(capture),
          info: vi.fn(capture),
        },
      });

      const assertions = [
        expect(client.inspectImage('example:latest')).rejects.toBeInstanceOf(DockerTimeoutError),
        expect(client.listNyabaseContainers()).rejects.toBeInstanceOf(DockerTimeoutError),
        expect(client.listImages()).rejects.toBeInstanceOf(DockerTimeoutError),
        expect(client.pingDaemon()).rejects.toBeInstanceOf(DockerTimeoutError),
        expect(client.daemonInfo()).rejects.toBeInstanceOf(DockerTimeoutError),
        expect(client.fetchContainerStats('runtime-a')).rejects.toBeInstanceOf(DockerTimeoutError),
      ];
      await vi.advanceTimersByTimeAsync(Math.max(
        DOCKER_READ_DEADLINES.inspect,
        DOCKER_READ_DEADLINES.list,
        DOCKER_READ_DEADLINES.daemon,
      ));
      await Promise.all(assertions);
      expect(signals).toHaveLength(assertions.length);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes every physical Unix socket after repeated read deadlines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nyabase-docker-read-'));
    const socketPath = join(dir, 'docker.sock');
    const activeSockets = new Set<Socket>();
    const server = createServer((_request, _response) => {
      // Deliberately never respond: only AbortSignal may retire the request.
    });
    server.on('connection', (socket) => {
      activeSockets.add(socket);
      socket.once('close', () => activeSockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      const docker = new Dockerode({ socketPath });
      for (let index = 0; index < 5; index += 1) {
        await expect(withAbortableDockerRead(
          (signal) => docker.listContainers({ all: true, abortSignal: signal }),
          20,
          `stalled-list-${index}`,
        )).rejects.toBeInstanceOf(DockerTimeoutError);
        await vi.waitFor(() => expect(activeSockets.size).toBe(0), { timeout: 1_000 });
      }
      expect(activeSockets.size).toBe(0);
    } finally {
      for (const socket of activeSockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bounds event-stream connection and destroys a stream delivered after timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolveEvents!: (stream: NodeJS.ReadableStream) => void;
      let eventSignal: AbortSignal | undefined;
      const opening = new Promise<NodeJS.ReadableStream>((resolve) => { resolveEvents = resolve; });
      const client = new DockerClient(makeConfig());
      Object.defineProperty(client, 'docker', {
        value: { getEvents: vi.fn((options: { abortSignal?: AbortSignal }) => {
          eventSignal = options.abortSignal;
          return opening;
        }) },
      });

      const connect = client.openContainerEventStream();
      const outcome = expect(connect).rejects.toBeInstanceOf(DockerTimeoutError);
      await vi.advanceTimersByTimeAsync(DOCKER_READ_DEADLINES.eventConnect);
      await outcome;
      expect(eventSignal?.aborted).toBe(true);
      const destroy = vi.fn();
      resolveEvents({ destroy } as unknown as NodeJS.ReadableStream);
      await Promise.resolve();
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DockerClient macvlan identity', () => {
  it.each([
    ['driver', { Driver: 'bridge' }],
    ['parent', { Options: { parent: 'eth9' } }],
    ['subnet', { IPAM: { Config: [{ Subnet: '10.9.0.0/24', Gateway: '10.0.0.1' }] } }],
    ['gateway', { IPAM: { Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.254' }] } }],
  ])('fails closed when the reserved network has mismatched %s', async (_field, overrides) => {
    const client = new DockerClient(makeConfig());
    const createNetwork = vi.fn();
    Object.defineProperty(client, 'docker', {
      value: {
        listNetworks: vi.fn().mockResolvedValue([{ Name: NYABASE_NETWORK, Id: 'network-a' }]),
        getNetwork: vi.fn(() => ({
          inspect: vi.fn().mockResolvedValue(networkInfo(overrides)),
        })),
        createNetwork,
      },
    });

    await expect(client.ensureMacvlanNetwork()).rejects.toThrow('does not match configured macvlan identity');
    expect(createNetwork).not.toHaveBeenCalled();
  });

  it('accepts only the exact configured macvlan network', async () => {
    const client = new DockerClient(makeConfig());
    Object.defineProperty(client, 'docker', {
      value: {
        listNetworks: vi.fn().mockResolvedValue([{ Name: NYABASE_NETWORK, Id: 'network-a' }]),
        getNetwork: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue(networkInfo()) })),
      },
    });

    await expect(client.ensureMacvlanNetwork()).resolves.toBeUndefined();
  });

  it('accepts a matching network after an explicit Docker conflict response and a fresh exact inspect', async () => {
    const client = new DockerClient(makeConfig());
    const listNetworks = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ Name: NYABASE_NETWORK, Id: 'network-a' }]);
    Object.defineProperty(client, 'docker', {
      value: {
        listNetworks,
        createNetwork: vi.fn().mockRejectedValue(
          Object.assign(new Error('network already exists'), { statusCode: 409 }),
        ),
        getNetwork: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue(networkInfo()) })),
      },
    });

    await expect(client.ensureMacvlanNetwork()).resolves.toBeUndefined();
    expect(listNetworks).toHaveBeenCalledTimes(2);
  });

  it('fail-stops when the network initialization mutation never settles', async () => {
    vi.useFakeTimers();
    try {
      const fatalHook = vi.fn();
      const listNetworks = vi.fn().mockResolvedValue([]);
      const createNetwork = vi.fn(() => new Promise<never>(() => {}));
      const client = new DockerClient(makeConfig(), { mutationDeadlineMs: 25, fatalHook });
      Object.defineProperty(client, 'docker', {
        value: { listNetworks, createNetwork },
      });
      let settled = false;
      const ensure = client.ensureMacvlanNetwork();
      void ensure.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      await vi.advanceTimersByTimeAsync(25);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: `network.create(${NYABASE_NETWORK})`,
        timeoutMs: 25,
      });
      expect(settled).toBe(false);
      expect(createNetwork).toHaveBeenCalledOnce();
      // The mutation never settled, so a post-error probe must not turn it
      // into a replayable result in this process.
      expect(listNetworks).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DockerClient.pullImage watchdog', () => {
  it('fail-stops a stalled pull and destroys a stream delivered after timeout', async () => {
    vi.useFakeTimers();
    try {
      const fatalHook = vi.fn();
      const client = new DockerClient(makeConfig(), { pullDeadlineMs: 25, fatalHook });
      let callback: ((error: Error | null, stream: NodeJS.ReadableStream) => void) | undefined;
      const destroy = vi.fn();
      Object.defineProperty(client, 'docker', {
        value: {
          pull: vi.fn((_ref: string, cb: typeof callback) => { callback = cb; }),
          modem: { followProgress: vi.fn() },
        },
      });

      const pull = client.pullImage('example:latest');
      let settled = false;
      void pull.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(fatalHook).toHaveBeenCalledOnce();
      expect(fatalHook.mock.calls[0][0]).toMatchObject({
        operation: 'pull(example:latest) progress',
        timeoutMs: 25,
      });
      expect(settled).toBe(false);

      callback?.(null, { destroy } as unknown as NodeJS.ReadableStream);
      expect(destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fail-stops an initial pull transport rejection and leaves the pull pending', async () => {
    const transportError = new Error('socket hang up');
    const fatalHook = vi.fn();
    const client = new DockerClient(makeConfig(), { fatalHook });
    Object.defineProperty(client, 'docker', {
      value: {
        pull: vi.fn((_ref: string, callback: (error: Error, stream?: NodeJS.ReadableStream) => void) => {
          callback(transportError);
        }),
      },
    });

    let settled = false;
    const pull = client.pullImage('example:latest');
    void pull.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();

    expect(fatalHook).toHaveBeenCalledOnce();
    expect(fatalHook.mock.calls[0][0]).toBeInstanceOf(DockerMutationTransportError);
    expect(fatalHook.mock.calls[0][0]).toMatchObject({
      operation: 'pull(example:latest) connect',
      transportError,
    });
    expect(settled).toBe(false);
  });

  it('propagates an explicit pull HTTP error without fail-stop', async () => {
    const responseError = Object.assign(new Error('manifest unknown'), { statusCode: 404 });
    const fatalHook = vi.fn();
    const client = new DockerClient(makeConfig(), { fatalHook });
    Object.defineProperty(client, 'docker', {
      value: {
        pull: vi.fn((_ref: string, callback: (error: Error, stream?: NodeJS.ReadableStream) => void) => {
          callback(responseError);
        }),
      },
    });

    await expect(client.pullImage('missing:latest')).rejects.toBe(responseError);
    expect(fatalHook).not.toHaveBeenCalled();
  });

  it('fail-stops a pull progress-stream transport error and leaves the pull pending', async () => {
    const transportError = new Error('response aborted');
    const fatalHook = vi.fn();
    const stream = { once: vi.fn(), destroy: vi.fn() } as unknown as NodeJS.ReadableStream;
    const client = new DockerClient(makeConfig(), { fatalHook });
    Object.defineProperty(client, 'docker', {
      value: {
        pull: vi.fn((_ref: string, callback: (error: null, stream: NodeJS.ReadableStream) => void) => {
          callback(null, stream);
        }),
        modem: {
          followProgress: vi.fn((
            _stream: NodeJS.ReadableStream,
            finished: (error: Error) => void,
          ) => finished(transportError)),
        },
      },
    });

    let settled = false;
    const pull = client.pullImage('example:latest');
    void pull.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();

    expect(fatalHook).toHaveBeenCalledOnce();
    expect(fatalHook.mock.calls[0][0]).toMatchObject({
      operation: 'pull(example:latest) progress',
      transportError,
    });
    expect(settled).toBe(false);
  });

  it('fail-stops a pull stream that closes without a complete response end', async () => {
    const fatalHook = vi.fn();
    const stream = { once: vi.fn(), destroy: vi.fn() } as unknown as NodeJS.ReadableStream;
    const client = new DockerClient(makeConfig(), { fatalHook });
    Object.defineProperty(client, 'docker', {
      value: {
        pull: vi.fn((_ref: string, callback: (error: null, stream: NodeJS.ReadableStream) => void) => {
          callback(null, stream);
        }),
        modem: {
          followProgress: vi.fn((
            _stream: NodeJS.ReadableStream,
            finished: (error: null) => void,
          ) => finished(null)),
        },
      },
    });

    let settled = false;
    const pull = client.pullImage('example:latest');
    void pull.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    await Promise.resolve();

    expect(fatalHook).toHaveBeenCalledOnce();
    expect(fatalHook.mock.calls[0][0]).toMatchObject({
      operation: 'pull(example:latest) progress',
      transportError: expect.objectContaining({
        message: 'Docker pull response closed before end',
      }),
    });
    expect(settled).toBe(false);
  });

  it('propagates a daemon error delivered in a completely received pull progress stream', async () => {
    const fatalHook = vi.fn();
    let onEnd: (() => void) | undefined;
    const stream = {
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'end') onEnd = listener;
      }),
    } as unknown as NodeJS.ReadableStream;
    const client = new DockerClient(makeConfig(), { fatalHook });
    Object.defineProperty(client, 'docker', {
      value: {
        pull: vi.fn((_ref: string, callback: (error: null, stream: NodeJS.ReadableStream) => void) => {
          callback(null, stream);
        }),
        modem: {
          followProgress: vi.fn((
            _stream: NodeJS.ReadableStream,
            finished: (error: null) => void,
            progress: (event: { errorDetail: { message: string } }) => void,
          ) => {
            progress({ errorDetail: { message: 'manifest unknown' } });
            onEnd?.();
            finished(null);
          }),
        },
      },
    });

    await expect(client.pullImage('missing:latest')).rejects.toThrow(
      'Docker pull failed: manifest unknown',
    );
    expect(fatalHook).not.toHaveBeenCalled();
  });
});

type MutationKind = 'create' | 'start' | 'restart' | 'remove';

function mutationFixture(kind: MutationKind, error: Error) {
  if (kind === 'create') {
    const createContainer = vi.fn().mockRejectedValue(error);
    return {
      operation: 'container.create(container-a)',
      docker: {
        createContainer,
        listContainers: vi.fn().mockResolvedValue([]),
      },
      invoke: (client: DockerClient) => client.createContainer(runtimeSpec()),
      physical: createContainer,
      entry: createContainer,
    };
  }

  const physical = vi.fn().mockRejectedValue(error);
  const getContainer = vi.fn(() => ({ [kind]: physical }));
  const invoke = (client: DockerClient): Promise<void> => {
    if (kind === 'start') return client.startContainer('runtime-a');
    if (kind === 'restart') return client.restartContainer('runtime-a');
    return client.removeContainer('runtime-a');
  };
  return {
    operation: `container.${kind}(runtime-a)`,
    docker: { getContainer },
    invoke,
    physical,
    entry: getContainer,
  };
}

function makeConfig(): AgentConfig {
  return {
    backendUrl: 'ws://localhost',
    agentToken: 'tok',
    serverId: 'srv-1',
    dockerRoot: '/var/lib/nyabase-docker',
    parentIface: 'eth0',
    macvlanCidr: '10.0.0.0/24',
    macvlanGateway: '10.0.0.1',
    reservedIps: [],
    metricsIntervalMs: 10_000,
    agentVersion: '0.1.0',
    isGpuServer: false,
    dockerResourceLimit: { enabled: false },
    localDataSources: [],
  };
}

function runtimeSpec(overrides: Record<string, unknown> = {}) {
  return {
    specGeneration: 1,
    name: 'work',
    imageRef: 'ubuntu:24.04',
    cpuMillis: 1000,
    memBytes: 1024,
    gpuIndices: [],
    ip: '10.0.0.2',
    containerId: 'container-a',
    ownerId: 'owner-a',
    imageId: 'image-a',
    runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
    serverId: 'server-a',
    mounts: [],
    ...overrides,
  };
}

function networkInfo(overrides: Record<string, unknown> = {}) {
  return {
    Name: NYABASE_NETWORK,
    Id: 'network-a',
    Driver: 'macvlan',
    Options: { parent: 'eth0' },
    IPAM: { Config: [{ Subnet: '10.0.0.0/24', Gateway: '10.0.0.1' }] },
    ...overrides,
  };
}
