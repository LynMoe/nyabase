import {
  AgentTaskKind,
  MAX_AGENT_TASK_RESULT_BYTES,
  canonicalJson,
  type TaskResultPayload,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AgentTaskEntity } from '../entities/agent-task.entity.js';
import {
  parseAndValidateStagedTerminalResult,
  StagedTerminalEvidenceError,
} from './agent-task-staged-result.js';
import { validateTerminalAgentResult } from './agent-task-result-validator.js';

const CLEANUP_PATHS = [
  '/var/lib/nyabase-docker/overlay/upper',
  '/var/lib/nyabase-docker/overlay/work',
] as const;

const NEVER_DISPATCHED_CASES = [
  [AgentTaskKind.ContainerCreate, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerStart, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerStop, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerRestart, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerDelete, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerSshEnsure, 'container-a', { containerId: 'container-a' }],
  [AgentTaskKind.ContainerRuntimeAbsent, 'runtime-a', { expectedRuntimeId: 'runtime-a' }],
  [AgentTaskKind.DataDirEnsure, 'datadir-a', { expectedResourceId: 'datadir-a' }],
  [AgentTaskKind.DataDirAbsent, 'datadir-a', { expectedResourceId: 'datadir-a' }],
  [AgentTaskKind.RemoteFsEnsure, 'remote-a', { id: 'remote-a' }],
  [AgentTaskKind.RemoteFsAbsent, 'remote-a', { id: 'remote-a' }],
  [AgentTaskKind.QuotaEnsure, 'user-a', { resourceId: 'user-a' }],
  [AgentTaskKind.ImageEnsurePresent, 'image-a', { resourceId: 'image-a' }],
  [AgentTaskKind.ImageEnsureAbsent, 'image-a', { resourceId: 'image-a' }],
] as const;

const NEVER_DISPATCHED_EXTRA_FIELDS = [
  ['foo', 'bar'],
  ['dockerId', 'sha256:physical'],
  ['mounted', true],
  ['exists', true],
  ['hardLimitBytes', 4096],
  ['quotaPaths', ['/physical/path']],
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
    [AgentTaskKind.DataDirEnsure, 'data-dir-a', dataDirEnsurePayload(), {
      path: dataDirPath(), exists: true, isDirectory: true,
      uid: 1001, gid: 1001, resourceId: 'data-dir-a', quotaAssigned: true,
    }],
    [AgentTaskKind.DataDirAbsent, 'data-dir-a', dataDirAbsentPayload(), {
      path: dataDirPath(), exists: false, isDirectory: false,
      uid: null, gid: null, resourceId: null, quotaAssigned: true,
    }],
    [AgentTaskKind.RemoteFsEnsure, 'remote-a', { hostMountPoint: '/mnt/remote-a' }, {
      id: 'remote-a', hostMountPoint: '/mnt/remote-a',
    }],
    [AgentTaskKind.RemoteFsAbsent, 'remote-a', {}, { id: 'remote-a' }],
    [AgentTaskKind.QuotaEnsure, 'user-a', { generation: 1, numericUserId: 1001, diskBytes: 4096 }, {
      numericUserId: 1001, hardLimitBytes: 4096,
    }],
    [AgentTaskKind.ImageEnsurePresent, 'image-a', {
      dockerRef: 'example.invalid/image:a', imageId: 'image-a',
    }, {
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

  it('enforces the ImageEnsurePresent optional image identity contract', () => {
    const withoutImageId = task(
      AgentTaskKind.ImageEnsurePresent,
      'image-a',
      { dockerRef: 'example.invalid/image:a' },
    );
    expect(() => validateTerminalAgentResult(withoutImageId, succeeded({
      imageId: null, dockerId: 'sha256:a', dockerRef: 'example.invalid/image:a',
    }))).not.toThrow();
    expect(() => validateTerminalAgentResult(withoutImageId, succeeded({
      imageId: 'image-a', dockerId: 'sha256:a', dockerRef: 'example.invalid/image:a',
    }))).toThrow(/image result identity/);
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ImageEnsurePresent, 'image-a', {
        dockerRef: 'example.invalid/image:a', imageId: 'image-other',
      }),
      succeeded({
        imageId: 'image-other', dockerId: 'sha256:a', dockerRef: 'example.invalid/image:a',
      }),
    )).toThrow(/payload imageId/);
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ImageEnsurePresent, 'image-a', {
        dockerRef: 'example.invalid/image:a', unexpected: true,
      }),
      succeeded({
        imageId: null, dockerId: 'sha256:a', dockerRef: 'example.invalid/image:a',
      }),
    )).toThrow(/unrecognized_keys/);
  });

  it('requires exact canonical DataDir paths and adjacent success state', () => {
    const ensureTask = task(
      AgentTaskKind.DataDirEnsure,
      'data-dir-a',
      dataDirEnsurePayload(),
    );
    const ensured = {
      path: dataDirPath(), exists: true, isDirectory: true,
      uid: 1001, gid: 1001, resourceId: 'data-dir-a', quotaAssigned: true,
    };
    expect(() => validateTerminalAgentResult(ensureTask, succeeded({
      ...ensured, path: '/mnt/data/.nyabase/dirs/data-dir-other/data',
    }))).toThrow(/exact .nyabase/);
    expect(() => validateTerminalAgentResult(ensureTask, succeeded({
      ...ensured, path: '/mnt/data/.nyabase/dirs/other/../data-dir-a/data',
    }))).toThrow(/exact .nyabase/);
    expect(() => validateTerminalAgentResult(ensureTask, succeeded({
      ...ensured, gid: 1002,
    }))).toThrow(/uid\/gid/);

    const absentTask = task(
      AgentTaskKind.DataDirAbsent,
      'data-dir-a',
      dataDirAbsentPayload(),
    );
    const absent = {
      path: dataDirPath(), exists: false, isDirectory: false,
      uid: null, gid: null, resourceId: null, quotaAssigned: true,
    };
    expect(() => validateTerminalAgentResult(absentTask, succeeded({
      ...absent, uid: 1001,
    }))).toThrow(/physical state/);
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.DataDirAbsent, 'data-dir-a', {
        ...dataDirAbsentPayload(), resourceId: 'data-dir-other',
      }),
      succeeded(absent),
    )).toThrow(/payload resourceId/);
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

  it('preserves strict pre-effect invalid-payload handling without reading corrupt durable payload', () => {
    const corruptTask = {
      ...task(AgentTaskKind.DataDirEnsure, 'data-dir-a', dataDirEnsurePayload()),
      payloadJson: 'corrupt-payload',
    } as unknown as AgentTaskEntity;
    expect(() => validateTerminalAgentResult(
      corruptTask,
      failed({ applied: false, reason: 'invalid_payload' }, 'invalid_task_payload'),
    )).not.toThrow();
    expect(() => validateTerminalAgentResult(
      corruptTask,
      failed({
        applied: false,
        reason: 'invalid_payload',
        path: dataDirPath(),
      }, 'invalid_task_payload'),
    )).toThrow(/exact no-effect/);
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

  it.each(NEVER_DISPATCHED_CASES)(
    'accepts only the exact no-send identity fields for %s',
    (kind, resourceId, identity) => {
      expect(() => validateTerminalAgentResult(
        task(kind, resourceId, {}),
        failed({ ...identity, applied: false, reason: 'never_dispatched' }, 'DISPATCH_PAYLOAD_INVALID'),
        { source: 'dispatch' },
      )).not.toThrow();
    },
  );

  it.each(NEVER_DISPATCHED_CASES)(
    'keeps exact staged no-send %s lazy with an unreadable payload',
    (kind, resourceId, identity) => {
      const staged = {
        ...task(kind, resourceId, {}),
        payloadJson: 'unreadable-payload',
        agentResultJson: {
          status: 'failed',
          error: { code: 'DISPATCH_PAYLOAD_INVALID', message: 'payload rejected before send' },
          observed: { ...identity, applied: false, reason: 'never_dispatched' },
        },
        failureStage: 'dispatch',
        startedAt: null,
        lastSentAt: null,
        errorJson: { code: 'DISPATCH_PAYLOAD_INVALID' },
      } as unknown as AgentTaskEntity;
      let codecCalls = 0;
      expect(() => parseAndValidateStagedTerminalResult(staged, () => {
        codecCalls += 1;
        throw new Error('exact no-send codec must remain lazy');
      })).not.toThrow();
      expect(codecCalls).toBe(0);
    },
  );

  it.each(NEVER_DISPATCHED_CASES.flatMap(([kind, resourceId, identity]) =>
    NEVER_DISPATCHED_EXTRA_FIELDS.map(([extraField, extraValue]) => [
      kind,
      resourceId,
      identity,
      extraField,
      extraValue,
    ] as const)))('rejects extra no-send %s field %s', (
    kind,
    resourceId,
    identity,
    extraField,
    extraValue,
  ) => {
    expect(() => validateTerminalAgentResult(
      task(kind, resourceId, {}),
      failed({
        ...identity,
        applied: false,
        reason: 'never_dispatched',
        [extraField]: extraValue,
      }, 'DISPATCH_PAYLOAD_INVALID'),
      { source: 'dispatch' },
    )).toThrow(/exact no-effect identity fields|physical runtime state/);
  });

  it('accepts a DataDir identity conflict as explicit no-touch failure evidence', () => {
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.DataDirAbsent, 'data-dir-a', dataDirAbsentPayload()),
      failed({
        path: dataDirPath(),
        expectedResourceId: 'data-dir-a', resourceId: 'data-dir-other',
        exists: true, isDirectory: true, uid: 1001, gid: 1001,
      }),
    )).not.toThrow();
  });

  it('accepts a fully observed DataDir quota mismatch and rejects an unobserved permanent failure', () => {
    const dataDirTask = task(
      AgentTaskKind.DataDirEnsure,
      'data-dir-a',
      dataDirEnsurePayload(),
    );
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      path: dataDirPath(),
      exists: false,
      isDirectory: false,
      uid: null,
      gid: null,
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
      path: dataDirPath(),
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
    }))).toThrow(/Invalid terminal result/);
  });

  it('rejects impossible or misaddressed ordinary DataDir failure observations', () => {
    const dataDirTask = task(
      AgentTaskKind.DataDirEnsure,
      'data-dir-a',
      dataDirEnsurePayload(),
    );
    const absent = {
      path: dataDirPath(), expectedResourceId: 'data-dir-a', resourceId: null,
      exists: false, isDirectory: false, uid: null, gid: null,
    };
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      ...absent, path: '/data/.nyabase/dirs/data-dir-other/data',
    }))).toThrow(/exact .nyabase/);
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      ...absent, isDirectory: true,
    }))).toThrow(/impossible inode state/);
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      ...absent, exists: true,
    }))).toThrow(/lacks uid\/gid/);
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      ...absent, expectedUid: 1002,
    }))).toThrow(/expected uid/);
    expect(() => validateTerminalAgentResult(dataDirTask, failed({
      ...absent, exists: true, uid: 1001, gid: 1001, resourceId: '../foreign',
    }))).toThrow(/Invalid terminal result/);
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.DataDirEnsure, 'data-dir-a', {
        ...dataDirEnsurePayload(), unexpected: true,
      }),
      failed(absent),
    )).toThrow(/unrecognized_keys/);
  });

  it('enforces the exact POSIX lexical and 4096-byte DataDir evidence boundary', () => {
    const dataDirTask = task(
      AgentTaskKind.DataDirEnsure,
      'data-dir-a',
      dataDirEnsurePayload(),
    );
    const suffix = '/.nyabase/dirs/data-dir-a/data';
    const pathAt4096 = `/${'a'.repeat(4096 - suffix.length - 1)}${suffix}`;
    const observed = (path: string) => ({
      path,
      expectedResourceId: 'data-dir-a',
      resourceId: null,
      exists: false,
      isDirectory: false,
      uid: null,
      gid: null,
    });

    expect(pathAt4096).toHaveLength(4096);
    expect(() => validateTerminalAgentResult(dataDirTask, failed(observed(pathAt4096))))
      .not.toThrow();
    for (const invalidPath of [
      `/${'a'.repeat(4097 - suffix.length - 1)}${suffix}`,
      `/bad\0root${suffix}`,
      `/bad\rroot${suffix}`,
      `/bad\nroot${suffix}`,
      `relative${suffix}`,
      `/root/../root${suffix}`,
      `/root//nested${suffix}`,
      '/root/.nyabase/dirs/data-dir-a/data-near',
      '/root/.nyabase/dirs/data-dir-other/data',
    ]) {
      expect(() => validateTerminalAgentResult(dataDirTask, failed(observed(invalidPath))))
        .toThrow(/Invalid terminal result/);
    }
  });

  it('strictly validates ImageEnsurePresent payload identity for ordinary failures', () => {
    const observed = {
      dockerRef: 'example.invalid/image:a',
      present: false,
      applied: false,
    };
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ImageEnsurePresent, 'image-a', {
        dockerRef: 'example.invalid/image:a', imageId: 'image-a',
      }),
      failed(observed),
    )).not.toThrow();
    expect(() => validateTerminalAgentResult(
      task(AgentTaskKind.ImageEnsurePresent, 'image-a', {
        dockerRef: 'example.invalid/image:a', imageId: 'image-other',
      }),
      failed(observed),
    )).toThrow(/payload imageId/);
  });

  it('applies the reconstructed wire byte limit after immutable identity injection', () => {
    const exact = stagedImageEvidenceAtWireBytes(MAX_AGENT_TASK_RESULT_BYTES);
    const exactTask = stagedTask(exact);
    expect(Buffer.byteLength(canonicalJson({
      ...exact,
      taskId: exactTask.id,
      payloadHash: exactTask.payloadHash,
    }))).toBe(MAX_AGENT_TASK_RESULT_BYTES);
    expect(() => parseAndValidateStagedTerminalResult(exactTask, exactTask.payloadJson)).not.toThrow();

    const oversized = stagedImageEvidenceAtWireBytes(MAX_AGENT_TASK_RESULT_BYTES + 1);
    const oversizedTask = stagedTask(oversized);
    expect(() => parseAndValidateStagedTerminalResult(oversizedTask, oversizedTask.payloadJson))
      .toThrow(StagedTerminalEvidenceError);
  });
});

function task(
  kind: AgentTaskKind,
  resourceId: string,
  payloadJson: Record<string, unknown>,
): AgentTaskEntity {
  return {
    id: 'task-a',
    kind,
    resourceType: resourceTypeFor(kind),
    resourceId,
    payloadJson,
    payloadHash: 'a'.repeat(64),
    serverId: 'server-a',
    failureStage: null,
    startedAt: new Date('2026-07-15T00:00:00.000Z'),
    lastSentAt: new Date('2026-07-15T00:00:00.000Z'),
  } as AgentTaskEntity;
}

function dataDirEnsurePayload(): Record<string, unknown> {
  return {
    resourceId: 'data-dir-a',
    generation: 1,
    diskId: 'disk-a',
    sourceIdentity: 'local:xfs:disk-a',
    quotaRequired: true,
    uid: 1001,
    numericUserId: 1001,
    quotaGeneration: 1,
    diskBytes: 4096,
  };
}

function dataDirAbsentPayload(): Record<string, unknown> {
  return {
    resourceId: 'data-dir-a',
    generation: 1,
    diskId: 'disk-a',
    sourceIdentity: 'local:xfs:disk-a',
    numericUserId: 1001,
  };
}

function dataDirPath(): string {
  return '/mnt/data/.nyabase/dirs/data-dir-a/data';
}

type StagedImageEvidence = {
  status: 'succeeded';
  result: { imageId: null; dockerId: string; dockerRef: string; diagnostic: string };
};

function stagedImageEvidenceAtWireBytes(targetBytes: number): StagedImageEvidence {
  const evidence: StagedImageEvidence = {
    status: 'succeeded',
    result: {
      imageId: null,
      dockerId: 'sha256:a',
      dockerRef: 'example.invalid/image:a',
      diagnostic: '',
    },
  };
  const baseBytes = Buffer.byteLength(canonicalJson({
    ...evidence,
    taskId: 'task-a',
    payloadHash: 'a'.repeat(64),
  }));
  if (targetBytes < baseBytes) throw new Error('target result size is too small');
  evidence.result.diagnostic = 'x'.repeat(targetBytes - baseBytes);
  return evidence;
}

function stagedTask(evidence: StagedImageEvidence): AgentTaskEntity {
  const staged = {
    ...task(
      AgentTaskKind.ImageEnsurePresent,
      'image-a',
      { dockerRef: 'example.invalid/image:a' },
    ),
    agentResultJson: evidence,
  } as AgentTaskEntity;
  staged.payloadHash = createHash('sha256')
    .update(canonicalJson({ kind: staged.kind, payload: staged.payloadJson }))
    .digest('hex');
  return staged;
}

function resourceTypeFor(kind: AgentTaskKind): string {
  if (kind === AgentTaskKind.ContainerRuntimeAbsent) return 'container_runtime';
  if (kind === AgentTaskKind.DataDirEnsure || kind === AgentTaskKind.DataDirAbsent) return 'datadir';
  if (kind === AgentTaskKind.RemoteFsEnsure || kind === AgentTaskKind.RemoteFsAbsent) return 'remote_fs_mount';
  if (kind === AgentTaskKind.QuotaEnsure) return 'quota';
  if (kind === AgentTaskKind.ImageEnsurePresent || kind === AgentTaskKind.ImageEnsureAbsent) return 'image';
  return 'container';
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
