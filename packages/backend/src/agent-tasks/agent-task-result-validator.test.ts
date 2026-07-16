import { AgentTaskKind, type TaskResultPayload } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import type { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';

const CLEANUP_PATHS = [
  '/var/lib/nyabase-docker/overlay/upper',
  '/var/lib/nyabase-docker/overlay/work',
] as const;

describe('validateTerminalAgentResult', () => {
  it.each([
    [AgentTaskKind.ContainerCreate, 'container-a', {
      dockerRoot: '/var/lib/nyabase-docker', assignedIp: '10.0.0.2',
    }, {
      containerId: 'container-a', runtimeId: 'runtime-a', ip: '10.0.0.2', quotaPaths: [
        '/var/lib/nyabase-docker/overlay/upper',
        '/var/lib/nyabase-docker/overlay/work',
      ],
      runtimeSpecHash: 'a'.repeat(64),
    }],
    [AgentTaskKind.ContainerStart, 'container-a', { runtimeId: 'runtime-a' }, {
      containerId: 'container-a', runtimeId: 'runtime-a', startedAt: 'now',
    }],
    [AgentTaskKind.ContainerStop, 'container-a', { runtimeId: 'runtime-a' }, {
      containerId: 'container-a', runtimeId: 'runtime-a', startedAt: 'now',
    }],
    [AgentTaskKind.ContainerRestart, 'container-a', { runtimeId: 'runtime-a' }, {
      containerId: 'container-a', runtimeId: 'runtime-a', startedAt: 'later',
    }],
    [AgentTaskKind.ContainerSshEnsure, 'container-a', { runtimeId: 'runtime-a' }, {
      containerId: 'container-a', runtimeId: 'runtime-a', ssh: { status: 'running' },
    }],
    [AgentTaskKind.ContainerDelete, 'container-a', { quotaPaths: [] }, {
      containerId: 'container-a', runtimeId: null, quotaPaths: [],
    }],
    [AgentTaskKind.ContainerRuntimeAbsent, 'runtime-extra', {
      runtimeId: 'runtime-extra', containerId: 'container-a', serverId: 'server-a',
      specGeneration: '3', runtimeSpecHash: 'a'.repeat(64), quotaPaths: CLEANUP_PATHS,
    }, {
      containerId: 'container-a', runtimeId: null, quotaPaths: CLEANUP_PATHS,
    }],
    [AgentTaskKind.DataDirEnsure, 'data-dir-a', { uid: 1001, quotaRequired: true }, {
      path: '/mnt/data/.nyabase/data-dirs/data-dir-a', exists: true, isDirectory: true,
      uid: 1001, gid: 1001, resourceId: 'data-dir-a', quotaAssigned: true,
    }],
    [AgentTaskKind.DataDirAbsent, 'data-dir-a', {}, {
      path: '/mnt/data/.nyabase/data-dirs/data-dir-a', exists: false, isDirectory: false,
      uid: null, gid: null, resourceId: null, quotaAssigned: true,
    }],
    [AgentTaskKind.RemoteFsEnsure, 'remote-a', { hostMountPoint: '/mnt/remote-a' }, {
      id: 'remote-a', hostMountPoint: '/mnt/remote-a',
    }],
    [AgentTaskKind.RemoteFsAbsent, 'remote-a', {}, { id: 'remote-a' }],
    [AgentTaskKind.QuotaEnsure, 'user-a', { generation: 1, numericUserId: 1001, diskBytes: 4096 }, {
      numericUserId: 1001, hardLimitBytes: 4096,
    }],
    [AgentTaskKind.ImageEnsurePresent, 'image-a', { dockerRef: 'example.invalid/image:a' }, {
      imageId: 'image-a', dockerId: 'sha256:a', dockerRef: 'example.invalid/image:a',
    }],
  ] as const)('accepts the Agent handler success shape for %s', (kind, resourceId, payload, result) => {
    expect(() => validateTerminalAgentResult(
      task(kind, resourceId, payload),
      succeeded(result),
    )).not.toThrow();
  });

  it('rejects a runtime identity mismatch even when the shape is valid', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerStart, 'container-a', { runtimeId: 'runtime-a' }),
      succeeded({ containerId: 'container-a', runtimeId: 'runtime-b' }),
    )).toThrow(/Invalid terminal result/);
  });

  it('accepts container failure only with an absent or stopped safety barrier', () => {
    const containerTask = task(
      AgentTaskKind.ContainerStart,
      'container-a',
      { runtimeId: 'runtime-a' },
    );
    expect(() => validateTerminalAgentResult(containerTask, failed({
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      serverId: 'server-a',
      running: false,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(containerTask, failed({
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      serverId: 'server-a',
      running: true,
    }))).toThrow(/safety barrier/);
    expect(() => validateTerminalAgentResult(containerTask, failed({
      containerId: 'container-a',
      runtimeId: 'runtime-b',
      serverId: 'server-a',
      running: false,
    }))).toThrow(/dispatched runtime identity/);
    expect(() => validateTerminalAgentResult(containerTask, failed({
      containerId: 'container-a',
      expectedRuntimeId: 'runtime-a',
      present: false,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(containerTask, failed({
      containerId: 'container-a',
      expectedRuntimeId: 'runtime-b',
      present: false,
    }))).toThrow(/dispatched runtime identity/);
  });

  it.each([
    AgentTaskKind.ContainerStart,
    AgentTaskKind.ContainerStop,
    AgentTaskKind.ContainerRestart,
    AgentTaskKind.ContainerSshEnsure,
  ])('rejects a stopped failure barrier for another runtime on %s', (kind) => {
    expect(() => validateTerminalAgentResult(
      task(kind, 'container-a', { runtimeId: 'runtime-a' }),
      failed({
        containerId: 'container-a', runtimeId: 'runtime-b',
        serverId: 'server-a', running: false,
      }),
    )).toThrow(/dispatched runtime identity/);
  });

  it('requires the dispatched delete runtime when the payload has an exact hint', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerDelete, 'container-a', { runtimeId: 'runtime-a' }),
      failed({
        containerId: 'container-a', runtimeId: 'runtime-b',
        serverId: 'server-a', running: false,
      }),
    )).toThrow(/dispatched runtime identity/);
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerDelete, 'container-a', { runtimeId: null }),
      failed({
        containerId: 'container-a', runtimeId: 'runtime-b',
        serverId: 'server-a', running: false,
      }),
    )).not.toThrow();
  });

  it('accepts exact no-touch evidence when a hinted runtime has drifted identity labels', () => {
    const containerTask = task(
      AgentTaskKind.ContainerStop,
      'container-a',
      { runtimeId: 'runtime-a' },
    );
    expect(() => validateTerminalAgentResult(containerTask, failed({
      expectedContainerId: 'container-a',
      containerId: 'container-other',
      runtimeId: 'runtime-a',
      managed: 'true',
      serverId: 'server-a',
      applied: false,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(containerTask, failed({
      expectedContainerId: 'container-other',
      containerId: 'container-other',
      runtimeId: 'runtime-a',
      managed: 'true',
      serverId: 'server-a',
      applied: false,
    }))).toThrow(/durable container identity/);
  });

  it('requires exact Docker-root quota recovery paths for a failed create that owns a stopped runtime', () => {
    const createTask = task(
      AgentTaskKind.ContainerCreate,
      'container-a',
      { dockerRoot: '/var/lib/nyabase-docker' },
    );
    const barrier = {
      containerId: 'container-a',
      runtimeId: 'runtime-a',
      serverId: 'server-a',
      running: false,
    };
    expect(() => validateTerminalAgentResult(createTask, failed({
      quotaPaths: [
        '/var/lib/nyabase-docker/overlay/upper',
        '/var/lib/nyabase-docker/overlay/work',
      ],
      safetyRollback: barrier,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(createTask, failed({
      safetyRollback: barrier,
    }))).toThrow(/Invalid terminal result/);
    expect(() => validateTerminalAgentResult(createTask, failed({
      quotaPaths: [
        '/var/lib/nyabase-docker/overlay/upper',
        '/var/lib/nyabase-docker/overlay/upper',
      ],
      safetyRollback: barrier,
    }))).toThrow(/duplicated/);
    expect(() => validateTerminalAgentResult(createTask, failed({
      quotaPaths: ['/etc/passwd', '/var/lib/nyabase-docker/overlay/work'],
      safetyRollback: barrier,
    }))).toThrow(/outside/);
  });

  it('accepts create no-touch evidence without binding cleanup metadata', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerCreate, 'container-a', { dockerRoot: '/var/lib/nyabase-docker' }),
      failed({ containerId: 'container-a', present: false, applied: false }),
    )).not.toThrow();
  });

  it('accepts a running malformed create claimant only when it is explicit no-touch evidence', () => {
    const createTask = task(
      AgentTaskKind.ContainerCreate,
      'container-a',
      { dockerRoot: '/var/lib/nyabase-docker' },
    );
    const claimant = {
      expectedContainerId: 'container-a',
      containerId: 'container-a',
      runtimeId: 'runtime-foreign',
      serverId: 'server-other',
      managed: 'true',
      running: true,
    };
    expect(() => validateTerminalAgentResult(createTask, failed({
      ...claimant,
      applied: false,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(createTask, failed(claimant)))
      .toThrow(/safety barrier/);
  });

  it('accepts only exact no-touch evidence for runtime cleanup identity changes', () => {
    const cleanupTask = task(AgentTaskKind.ContainerRuntimeAbsent, 'runtime-extra', {
      runtimeId: 'runtime-extra', containerId: 'container-a', serverId: 'server-a',
      specGeneration: '3', runtimeSpecHash: 'a'.repeat(64), quotaPaths: CLEANUP_PATHS,
    });
    expect(() => validateTerminalAgentResult(cleanupTask, failed({
      runtimeId: 'runtime-extra',
      expectedRuntimeId: 'runtime-extra',
      expectedContainerId: 'container-a',
      expectedServerId: 'server-a',
      expectedQuotaPaths: CLEANUP_PATHS,
      applied: false,
      present: true,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(cleanupTask, failed({
      runtimeId: 'runtime-reused',
      expectedRuntimeId: 'runtime-reused',
      expectedContainerId: 'container-a',
      expectedServerId: 'server-a',
      expectedQuotaPaths: CLEANUP_PATHS,
      applied: false,
      present: true,
    }))).toThrow(/exact dispatched identity/);
  });

  it('rejects runtime cleanup success or failure evidence with different persisted paths', () => {
    const cleanupTask = task(AgentTaskKind.ContainerRuntimeAbsent, 'runtime-extra', {
      runtimeId: 'runtime-extra', containerId: 'container-a', serverId: 'server-a',
      specGeneration: '3', runtimeSpecHash: 'a'.repeat(64), quotaPaths: CLEANUP_PATHS,
    });
    expect(() => validateTerminalAgentResult(cleanupTask, succeeded({
      containerId: 'container-a', runtimeId: null,
      quotaPaths: ['/var/lib/nyabase-docker/overlay/other', CLEANUP_PATHS[1]],
    }))).toThrow(/paths do not match/);
    expect(() => validateTerminalAgentResult(cleanupTask, failed({
      expectedRuntimeId: 'runtime-extra',
      expectedContainerId: 'container-a',
      expectedServerId: 'server-a',
      expectedQuotaPaths: ['/var/lib/nyabase-docker/overlay/other', CLEANUP_PATHS[1]],
      applied: false,
    }))).toThrow(/exact dispatched identity/);
  });

  it('rejects RemoteFS failure evidence with the unsafe residual state', () => {
    const mountTask = task(
      AgentTaskKind.RemoteFsEnsure,
      'remote-a',
      { hostMountPoint: '/mnt/remote-a' },
    );
    expect(() => validateTerminalAgentResult(mountTask, failed({
      id: 'remote-a', hostMountPoint: '/mnt/remote-a', mounted: false,
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(mountTask, failed({
      id: 'remote-a', hostMountPoint: '/mnt/remote-a', mounted: true,
    }))).toThrow(/mounted=false/);
  });

  it.each([AgentTaskKind.RemoteFsEnsure, AgentTaskKind.RemoteFsAbsent])(
    'accepts exact no-touch running-bind evidence for %s',
    (kind) => {
      const mountTask = task(kind, 'remote-a', { hostMountPoint: '/mnt/remote-a' });
      expect(() => validateTerminalAgentResult(mountTask, failed({
        id: 'remote-a',
        desiredHostMountPoint: '/mnt/remote-a',
        applied: false,
        reason: 'running_bind_reference',
        residualPresent: true,
        targetPath: '/mnt/old-remote-a',
        sourcePath: '/mnt/old-remote-a/work',
        runtimeId: 'runtime-a',
      }))).not.toThrow();
      expect(() => validateTerminalAgentResult(mountTask, failed({
        id: 'remote-a',
        desiredHostMountPoint: '/mnt/other',
        applied: false,
        reason: 'running_bind_reference',
        residualPresent: true,
        targetPath: '/mnt/old-remote-a',
        sourcePath: '/mnt/old-remote-a/work',
        runtimeId: 'runtime-a',
      }))).toThrow(/desired path/);
    },
  );

  it('rejects a quota success whose hard limit differs from the normalized request', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.QuotaEnsure, 'user-a', { generation: 1, numericUserId: 1001, diskBytes: 1025 }),
      succeeded({ numericUserId: 1001, hardLimitBytes: 1024 }),
    )).toThrow(/quota hard limit/);
  });

  it('rejects incomplete applied-false container evidence', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerStop, 'container-a', { runtimeId: 'runtime-a' }),
      failed({ containerId: 'container-a', applied: false }),
    )).toThrow(/exact no-effect observation/);
  });

  it.each([
    'invalid_task_payload',
    'task_payload_hash_mismatch',
    'unsupported_task_kind',
  ])('accepts exact pre-effect terminal evidence for %s', (code) => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerStop, 'container-a', { runtimeId: 'runtime-a' }),
      failed({ applied: false, reason: 'invalid_payload' }, code),
    )).not.toThrow();
  });

  it('rejects the invalid-payload bypass for unrelated terminal errors', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ContainerStop, 'container-a', { runtimeId: 'runtime-a' }),
      failed({ applied: false, reason: 'invalid_payload' }),
    )).toThrow(/unsupported terminal error code/);
  });

  it('accepts never-dispatched evidence only from the exact Backend dispatch-failure context', () => {
    const containerTask = task(
      AgentTaskKind.ContainerStart,
      'container-a',
      { runtimeId: 'runtime-a' },
    );
    const result = failed({
      containerId: 'container-a',
      applied: false,
      reason: 'never_dispatched',
    }, 'DISPATCH_PAYLOAD_INVALID');
    expect(() => validateTerminalAgentResult(
      containerTask,
      result,
      { source: 'dispatch' },
    )).not.toThrow();
    expect(() => validateTerminalAgentResult(containerTask, result))
      .toThrow(/only for Backend dispatch failure/);
    expect(() => validateTerminalAgentResult(
      containerTask,
      failed({
        containerId: 'container-a',
        present: false,
        applied: false,
        reason: 'never_dispatched',
      }, 'DISPATCH_PAYLOAD_INVALID'),
      { source: 'dispatch' },
    )).toThrow(/must not claim physical runtime state/);
  });

  it('accepts a DataDir identity conflict as explicit no-touch failure evidence', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.DataDirAbsent, 'data-dir-a', {}),
      failed({
        expectedResourceId: 'data-dir-a', resourceId: 'data-dir-other',
        exists: true, isDirectory: true,
      }),
    )).not.toThrow();
  });

  it('accepts a fully observed DataDir quota mismatch and rejects an unobserved permanent failure', () => {
    const dataDirTask = task(AgentTaskKind.DataDirEnsure, 'data-dir-a', { uid: 1001, quotaRequired: true });
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      path: '/data/.nyabase/dirs/data-dir-a/data',
      exists: false,
      isDirectory: false,
      resourceId: null,
      expectedResourceId: 'data-dir-a',
      applied: false,
      quotaObservation: {
        numericUserId: 1001,
        expectedHardLimitBytes: 4096,
        observed: null,
      },
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      path: '/data/.nyabase/dirs/data-dir-a/data',
      exists: true,
      isDirectory: true,
      uid: 1001,
      gid: 1001,
      resourceId: 'data-dir-a',
      expectedResourceId: 'data-dir-a',
      quotaObservation: {
        numericUserId: 1001,
        expectedHardLimitBytes: 4096,
        observed: {
          numericUserId: 1001,
          projectId: 11001,
          usedBytes: 0,
          hardLimitBytes: 2048,
        },
      },
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      expectedResourceId: 'data-dir-a',
      applied: false,
      quotaObservation: { observed: null },
    }))).toThrow(/complete physical type observation/);
  });
});

function task(
  kind: AgentTaskKind,
  resourceId: string,
  payloadJson: Record<string, unknown>,
): AgentTaskEntity {
  return { kind, resourceId, payloadJson, serverId: 'server-a' } as AgentTaskEntity;
}

function failed(
  observed: Record<string, unknown>,
  errorCode = 'failed',
): Extract<TaskResultPayload, { status: 'failed' }> {
  return {
    taskId: 'task-a',
    payloadHash: 'hash-a',
    status: 'failed',
    error: { code: errorCode, message: 'failed' },
    observed,
  };
}

function succeeded(result: object | null): Extract<TaskResultPayload, { status: 'succeeded' }> {
  return {
    taskId: 'task-a',
    payloadHash: 'hash-a',
    status: 'succeeded',
    result,
  };
}
