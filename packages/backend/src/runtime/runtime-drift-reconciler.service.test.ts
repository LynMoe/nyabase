import { DataSource, type EntityManager } from 'typeorm';
import {
  AgentTaskKind,
  AgentTaskStatus,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  LABEL,
  MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER,
  ServerStatus,
  type ContainerSnapshot,
} from '@nyabase/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { ResourceLockedException } from '../agent-tasks/resource-lock.service.js';
import type { EnqueueAgentTaskInput } from '../agent-tasks/agent-task.types.js';
import { ContainerDesiredSpecEntity } from '../entities/container-desired-spec.entity.js';
import { ContainerEntity } from '../entities/container.entity.js';
import { ContainerLifecycleEntity } from '../entities/container-lifecycle.entity.js';
import { ContainerMountEntity } from '../entities/container-mount.entity.js';
import { DataDirectoryEntity } from '../entities/data-directory.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AgentTaskEntity } from '../entities/agent-task.entity.js';
import { NetworkAddressClaimEntity } from '../entities/network-address-claim.entity.js';
import { QuotaDesiredEntity } from '../entities/quota-desired.entity.js';
import { ServerEntity } from '../entities/server.entity.js';
import { RuntimeDriftReconcilerService } from './runtime-drift-reconciler.service.js';

const SERVER_ID = 'server-a';
const HASH = 'a'.repeat(64);
const DOCKER_ROOT = '/var/lib/nyabase-docker';

describe('RuntimeDriftReconcilerService', () => {
  let dataSource: DataSource;
  let service: RuntimeDriftReconcilerService;
  let enqueued: Array<EnqueueAgentTaskInput & { taskId: string }>;
  let activeLocks: Map<string, string>;
  let enqueueInTransaction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      synchronize: true,
      entities: [
        ContainerEntity,
        ContainerDesiredSpecEntity,
        ContainerLifecycleEntity,
        ContainerMountEntity,
        DataDirectoryEntity,
        QuotaDesiredEntity,
        ServerEntity,
        ImageEntity,
        AgentTaskEntity,
        NetworkAddressClaimEntity,
      ],
    });
    await dataSource.initialize();
    await dataSource.getRepository(ServerEntity).save({
      id: SERVER_ID,
      name: 'Server A',
      slug: 'server-a',
      agentTokenHash: 'token-hash-a',
      hostFingerprint: null,
      agentConfigFingerprint: null,
      status: ServerStatus.Offline,
      lastSeenAt: null,
      macvlanCidr: '10.0.0.0/24',
      macvlanGateway: '10.0.0.1',
      macvlanReservedIps: [],
    });
    await dataSource.getRepository(ImageEntity).save({
      id: 'image-a',
      name: 'Image A',
      dockerImage: 'image:a',
      runtimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      description: null,
      isActive: true,
      disableSsh: false,
    });
    enqueued = [];
    activeLocks = new Map();
    enqueueInTransaction = vi.fn(async (
      manager: EntityManager,
      input: EnqueueAgentTaskInput,
    ) => {
      const taskId = `task-${enqueued.length + 1}`;
      const keys = input.resourceKeys ?? [];
      const conflicts = keys
        .filter((key) => activeLocks.has(key))
        .map((key) => ({ resourceKey: key, taskId: activeLocks.get(key)! }));
      if (conflicts.length > 0) throw new ResourceLockedException(conflicts);
      for (const key of keys) activeLocks.set(key, taskId);
      enqueued.push({ ...input, taskId });
      await manager.save(AgentTaskEntity, manager.create(AgentTaskEntity, {
        id: taskId,
        kind: input.kind,
        serverId: input.serverId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        requestedBy: input.requestedBy,
        requestJson: input.request ?? null,
        payloadJson: input.payload,
        payloadHash: `hash-${taskId}`,
        status: AgentTaskStatus.Pending,
        failureStage: null,
        agentResultJson: null,
        dispatchAttemptCount: 0,
        nextDispatchAt: input.nextDispatchAt ?? null,
        finalizerAttemptCount: 0,
        finalizerRetryAt: null,
        resultJson: null,
        errorJson: null,
        startedAt: null,
        lastSentAt: null,
        completedAt: null,
      }));
      await input.beforeCommit?.(manager, { taskId });
      return { ok: true as const, taskId, status: AgentTaskStatus.Pending };
    });
    service = new RuntimeDriftReconcilerService(
      dataSource,
      { enqueueInTransaction } as never,
      new ResourceKeyService(),
    );
  });

  afterEach(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  it('queues exact cleanup for an unknown managed product id', async () => {
    const report = snapshot('runtime-unknown', 'container-unknown');

    const result = await service.reconcile(SERVER_ID, [report], DOCKER_ROOT);

    expect(result.taskIds).toEqual(['task-1']);
    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      serverId: SERVER_ID,
      resourceType: 'container_runtime',
      resourceId: 'runtime-unknown',
      requestedBy: null,
      payload: {
        runtimeId: 'runtime-unknown',
        containerId: 'container-unknown',
        serverId: SERVER_ID,
        specGeneration: '1',
        runtimeSpecHash: HASH,
        quotaPaths: [
          `${DOCKER_ROOT}/overlay2/runtime-unknown/diff`,
          `${DOCKER_ROOT}/overlay2/runtime-unknown/work`,
        ],
      },
      resourceKeys: [
        'runtime:server-a:runtime-unknown',
      ],
      admissionClass: 'safety',
    });
  });

  it('retains the bounded claim and retries cleanup enqueue after queue pressure clears', async () => {
    enqueueInTransaction.mockRejectedValueOnce({
      getResponse: () => ({ code: 'AGENT_TASK_QUEUE_FULL' }),
    });
    const report = snapshot('runtime-deferred', 'container-deferred');

    const deferred = await service.reconcile(SERVER_ID, [report], DOCKER_ROOT);

    expect(deferred).toEqual({
      taskIds: [],
      failedContainerIds: [],
      claimsChanged: true,
      quarantineReason: null,
    });
    expect(await dataSource.getRepository(NetworkAddressClaimEntity).findOneBy({
      ownerKind: 'runtime_cleanup',
      ownerId: 'runtime-deferred',
      serverId: SERVER_ID,
      state: 'active',
    })).not.toBeNull();
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .not.toMatchObject({ status: ServerStatus.AgentQuarantined });

    const retried = await service.reconcile(SERVER_ID, [report], DOCKER_ROOT);
    expect(retried.taskIds).toEqual(['task-1']);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      resourceId: 'runtime-deferred',
    });
  });

  it('quarantines without growing past the active runtime cleanup claim cap', async () => {
    const claims = Array.from(
      { length: MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER },
      (_, index) => {
        const runtimeId = `retained-runtime-${index}`;
        const address = `10.0.0.${index + 2}`;
        return {
          id: `retained-claim-${index}`,
          address,
          networkKey: '10.0.0.0/24',
          ownerKind: 'runtime_cleanup' as const,
          ownerId: runtimeId,
          serverId: SERVER_ID,
          state: 'active' as const,
          cleanupPayloadJson: {
            runtimeId,
            containerId: `retained-container-${index}`,
            serverId: SERVER_ID,
            specGeneration: '1',
            runtimeSpecHash: HASH,
            quotaPaths: [
              `${DOCKER_ROOT}/overlay2/${runtimeId}/diff`,
              `${DOCKER_ROOT}/overlay2/${runtimeId}/work`,
            ],
            observedIp: address,
          },
          reusableAt: null,
        };
      },
    );
    await dataSource.getRepository(NetworkAddressClaimEntity).save(claims);

    const result = await service.reconcile(
      SERVER_ID,
      [snapshot('overflow-runtime', 'overflow-container', { ip: '10.0.0.250' })],
      DOCKER_ROOT,
    );

    expect(result).toMatchObject({
      taskIds: [],
      failedContainerIds: [],
      claimsChanged: true,
      quarantineReason: expect.stringContaining('capacity'),
    });
    expect(enqueued).toEqual([]);
    expect(await dataSource.getRepository(NetworkAddressClaimEntity).count({
      where: { ownerKind: 'runtime_cleanup', serverId: SERVER_ID, state: 'active' },
    })).toBe(MAX_ACTIVE_RUNTIME_CLEANUP_CLAIMS_PER_SERVER);
    expect(await dataSource.getRepository(ServerEntity).findOneByOrFail({ id: SERVER_ID }))
      .toMatchObject({ status: ServerStatus.AgentQuarantined });
  });

  it('refuses to persist cleanup paths outside the canonical Docker root', async () => {
    const report = snapshot('runtime-unknown', 'container-unknown');
    report.runtime.quotaPaths = ['/etc/unsafe-upper', '/etc/unsafe-work'];

    await expect(service.reconcile(SERVER_ID, [report], DOCKER_ROOT)).rejects.toThrow(
      'invalid writable-layer recovery paths',
    );
    expect(enqueued).toEqual([]);
  });

  it('queues cleanup for a runtime claiming a container owned by another server', async () => {
    await seedContainer('container-a', {
      container: { serverId: 'server-b' },
      lifecycle: { boundRuntimeId: 'runtime-a' },
    });

    await service.reconcile(SERVER_ID, [snapshot('runtime-a', 'container-a')], DOCKER_ROOT);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe(AgentTaskKind.ContainerRuntimeAbsent);
  });

  it('keeps the exact bound hash/generation canonical and cleans only a duplicate extra', async () => {
    await seedContainer('container-a');
    const canonical = snapshot('runtime-a', 'container-a');
    const extra = snapshot('runtime-extra', 'container-a');

    const result = await service.reconcile(SERVER_ID, [extra, canonical], DOCKER_ROOT);

    expect(result.failedContainerIds).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      resourceId: 'runtime-extra',
    });
    expect((await lifecycle('container-a')).phase).toBe(ContainerPhase.Active);
  });

  it('fails closed when no runtime matches the durable binding and cleans the mismatched claimant', async () => {
    await seedContainer('container-a');

    const result = await service.reconcile(
      SERVER_ID,
      [snapshot('runtime-other', 'container-a', { runtimeSpecHash: 'b'.repeat(64) })],
      DOCKER_ROOT,
    );

    expect(result.failedContainerIds).toEqual(['container-a']);
    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      resourceId: 'runtime-other',
    });
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Failed,
      activeTaskId: null,
      failureCode: 'runtime_missing',
    });
  });

  it('treats a runtime with a mismatched durable desired generation as non-canonical', async () => {
    await seedContainer('container-a', { desired: { generation: 2 } });
    const stale = snapshot('runtime-a', 'container-a', { specGeneration: '1' });

    const result = await service.reconcile(SERVER_ID, [stale], DOCKER_ROOT);

    expect(result.failedContainerIds).toEqual(['container-a']);
    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerRuntimeAbsent,
      resourceId: 'runtime-a',
      payload: { specGeneration: '1' },
    });
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Failed,
      failureCode: 'runtime_missing',
    });
  });

  it('does not guess or clean a runtime while a provisioning task owns the lifecycle', async () => {
    await seedContainer('container-a', {
      lifecycle: {
        phase: ContainerPhase.Provisioning,
        activeTaskId: 'create-task',
        boundRuntimeId: null,
        runtimeSpecHash: null,
      },
    });
    await dataSource.getRepository(AgentTaskEntity).save(pendingTask(
      'create-task',
      AgentTaskKind.ContainerCreate,
      'container-a',
      { containerId: 'container-a', assignedIp: '10.0.0.2' },
    ));

    const result = await service.reconcile(
      SERVER_ID,
      [snapshot('runtime-new', 'container-a')],
      DOCKER_ROOT,
    );

    expect(result).toEqual({
      taskIds: [], failedContainerIds: [], claimsChanged: true, quarantineReason: null,
    });
    expect(enqueued).toEqual([]);
    expect((await lifecycle('container-a')).phase).toBe(ContainerPhase.Provisioning);
  });

  it('claims a staged task runtime on the wrong address before any old claim can drain', async () => {
    await seedContainer('container-a', {
      lifecycle: {
        phase: ContainerPhase.Provisioning,
        activeTaskId: 'create-task',
        boundRuntimeId: null,
        runtimeSpecHash: null,
      },
    });
    const createTask = pendingTask(
      'create-task',
      AgentTaskKind.ContainerCreate,
      'container-a',
      { containerId: 'container-a', assignedIp: '10.0.0.2' },
    );
    createTask.agentResultJson = {
      status: 'failed',
      error: { code: 'CREATE_FAILED', message: 'finalizer pending' },
      observed: { runtimeId: 'runtime-staged' },
    };
    await dataSource.getRepository(AgentTaskEntity).save(createTask);
    await dataSource.getRepository(NetworkAddressClaimEntity).save({
      id: 'old-staged-address',
      address: '10.0.0.8',
      networkKey: '10.0.0.0/24',
      ownerKind: 'runtime_cleanup',
      ownerId: 'runtime-staged',
      serverId: SERVER_ID,
      state: 'active',
      cleanupPayloadJson: {
        runtimeId: 'runtime-staged',
        containerId: 'container-a',
        serverId: SERVER_ID,
        specGeneration: '1',
        runtimeSpecHash: HASH,
        quotaPaths: [
          `${DOCKER_ROOT}/overlay2/runtime-staged/diff`,
          `${DOCKER_ROOT}/overlay2/runtime-staged/work`,
        ],
        observedIp: '10.0.0.8',
      },
      reusableAt: null,
    });

    const result = await service.reconcile(
      SERVER_ID,
      [snapshot('runtime-staged', 'container-a', { ip: '10.0.0.9' })],
      DOCKER_ROOT,
    );

    expect(result.taskIds).toEqual([]);
    expect(enqueued).toEqual([]);
    const claims = await dataSource.getRepository(NetworkAddressClaimEntity).find({
      where: { ownerKind: 'runtime_cleanup', ownerId: 'runtime-staged', serverId: SERVER_ID },
      order: { address: 'ASC' },
    });
    expect(claims.map((claim) => [claim.address, claim.state])).toEqual([
      ['10.0.0.8', 'active'],
      ['10.0.0.9', 'active'],
    ]);
    expect((await lifecycle('container-a')).activeTaskId).toBe('create-task');
  });

  it('still records every later in-flight create runtime after an earlier product changed claims', async () => {
    await seedContainer('b-container', {
      lifecycle: {
        phase: ContainerPhase.Provisioning,
        activeTaskId: 'create-task-b',
        boundRuntimeId: null,
        runtimeSpecHash: null,
      },
    });
    await dataSource.getRepository(AgentTaskEntity).save(pendingTask(
      'create-task-b',
      AgentTaskKind.ContainerCreate,
      'b-container',
      { containerId: 'b-container', assignedIp: '10.0.0.2' },
    ));

    const result = await service.reconcile(SERVER_ID, [
      snapshot('runtime-orphan-first', 'a-unknown'),
      snapshot('runtime-create-later', 'b-container'),
    ], DOCKER_ROOT);

    expect(result.claimsChanged).toBe(true);
    expect(await dataSource.getRepository(NetworkAddressClaimEntity).findOneBy({
      ownerKind: 'runtime_cleanup',
      ownerId: 'runtime-create-later',
      serverId: SERVER_ID,
      state: 'active',
    })).not.toBeNull();
    expect(enqueued.map((task) => task.resourceId)).toContain('runtime-orphan-first');
    expect(enqueued.map((task) => task.resourceId)).not.toContain('runtime-create-later');
  });

  it('still releases a later canonical runtime claim after an earlier product changed claims', async () => {
    await seedContainer('b-container', {
      lifecycle: { boundRuntimeId: 'runtime-canonical-later' },
    });
    await dataSource.getRepository(NetworkAddressClaimEntity).save({
      id: 'runtime-canonical-claim',
      address: '10.0.0.2',
      networkKey: '10.0.0.0/24',
      ownerKind: 'runtime_cleanup',
      ownerId: 'runtime-canonical-later',
      serverId: SERVER_ID,
      state: 'active',
      cleanupPayloadJson: {
        runtimeId: 'runtime-canonical-later',
        containerId: 'b-container',
        serverId: SERVER_ID,
        specGeneration: '1',
        runtimeSpecHash: HASH,
        quotaPaths: [
          `${DOCKER_ROOT}/overlay2/runtime-canonical-later/diff`,
          `${DOCKER_ROOT}/overlay2/runtime-canonical-later/work`,
        ],
        observedIp: '10.0.0.2',
      },
      reusableAt: null,
    });

    const result = await service.reconcile(SERVER_ID, [
      snapshot('runtime-orphan-first', 'a-unknown'),
      snapshot('runtime-canonical-later', 'b-container'),
    ], DOCKER_ROOT);

    expect(result.claimsChanged).toBe(true);
    expect(await dataSource.getRepository(NetworkAddressClaimEntity).findOneByOrFail({
      id: 'runtime-canonical-claim',
    })).toMatchObject({ state: 'releasing' });
  });

  it('cleans every reported residual before an unbound delete may prove success', async () => {
    await seedContainer('container-a', {
      lifecycle: {
        phase: ContainerPhase.Deleting,
        activeTaskId: 'delete-task',
        boundRuntimeId: null,
        runtimeSpecHash: null,
      },
    });
    await dataSource.getRepository(AgentTaskEntity).save(pendingTask(
      'delete-task',
      AgentTaskKind.ContainerDelete,
      'container-a',
      {
        containerId: 'container-a',
        runtimeId: null,
        serverId: SERVER_ID,
        specGeneration: null,
        runtimeSpecHash: null,
        numericOwnerId: 42,
        quotaPaths: [],
      },
    ));
    const residuals = [
      snapshot('runtime-residual-a', 'container-a'),
      snapshot('runtime-residual-b', 'container-a'),
    ];

    const result = await service.reconcile(SERVER_ID, residuals, DOCKER_ROOT);

    expect(result.taskIds).toEqual(['task-1', 'task-2']);
    expect(result.claimsChanged).toBe(true);
    expect(enqueued).toHaveLength(2);
    expect(enqueued.map((entry) => entry.resourceId).sort()).toEqual([
      'runtime-residual-a',
      'runtime-residual-b',
    ]);
    expect(enqueued).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: AgentTaskKind.ContainerRuntimeAbsent,
        admissionClass: 'safety',
      }),
    ]));
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Deleting,
      activeTaskId: 'delete-task',
      boundRuntimeId: null,
    });
  });

  it.each([
    ContainerPhase.Provisioning,
    ContainerPhase.Updating,
    ContainerPhase.Deleting,
  ].flatMap((phase) => [true, false].map((reported) => [phase, reported] as const)))(
    'fails an ownerless %s lifecycle whether runtime reported is %s',
    async (phase, reported) => {
      await seedContainer('container-a', {
        lifecycle: { phase, activeTaskId: null },
      });

      const result = await service.reconcile(
        SERVER_ID,
        reported ? [snapshot('runtime-a', 'container-a')] : [],
        DOCKER_ROOT,
      );

      expect(result.failedContainerIds).toEqual(['container-a']);
      expect(enqueued).toHaveLength(reported ? 1 : 0);
      expect(await lifecycle('container-a')).toMatchObject({
        phase: ContainerPhase.Failed,
        activeTaskId: null,
        boundRuntimeId: 'runtime-a',
        failureCode: 'runtime_lifecycle_owner_missing',
      });
    },
  );

  it('fails without deleting a reported runtime when its durable desired generation is missing', async () => {
    await seedContainer('container-a');
    await dataSource.getRepository(ContainerDesiredSpecEntity).delete({ containerId: 'container-a' });

    const result = await service.reconcile(
      SERVER_ID,
      [snapshot('runtime-a', 'container-a')],
      DOCKER_ROOT,
    );

    expect(result.failedContainerIds).toEqual(['container-a']);
    expect(enqueued).toHaveLength(1);
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Failed,
      boundRuntimeId: 'runtime-a',
      failureCode: 'runtime_desired_missing',
    });
  });

  it('turns a missing active runtime into an explicit durable failed state', async () => {
    await seedContainer('container-a');

    const result = await service.reconcile(SERVER_ID, [], DOCKER_ROOT);

    expect(result.failedContainerIds).toEqual(['container-a']);
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Failed,
      failureCode: 'runtime_missing',
      activeTaskId: null,
    });
    expect(enqueued).toEqual([]);
  });

  it('deduplicates repeated cleanup reports through the runtime and container resource locks', async () => {
    const report = snapshot('runtime-unknown', 'container-unknown');

    const first = await service.reconcile(SERVER_ID, [report], DOCKER_ROOT);
    const second = await service.reconcile(SERVER_ID, [report], DOCKER_ROOT);

    expect(first.taskIds).toEqual(['task-1']);
    expect(second.taskIds).toEqual(['task-1']);
    expect(enqueued).toHaveLength(1);
  });

  it('queues a durable start after startup quiesce reports the canonical desired-running runtime stopped', async () => {
    await seedContainer('container-a', {
      desired: { powerIntent: ContainerPowerIntent.Running },
    });
    await dataSource.getRepository(QuotaDesiredEntity).save({
      id: 'quota-a', serverId: SERVER_ID, userId: 'user-a', generation: 4,
      numericUserId: 42, limitBytes: 8192, lastTaskId: 'quota-task',
    });

    const result = await service.reconcile(
      SERVER_ID,
      [snapshot('runtime-a', 'container-a', { status: ContainerStatus.Exited })],
      DOCKER_ROOT,
    );

    expect(result.taskIds).toEqual(['task-1']);
    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerStart,
      resourceType: 'container',
      resourceId: 'container-a',
      payload: {
        containerId: 'container-a',
        runtimeId: 'runtime-a',
        dockerRoot: DOCKER_ROOT,
        quotaGeneration: 4,
        numericOwnerId: 42,
        diskBytes: 8192,
        quotaPaths: [
          `${DOCKER_ROOT}/overlay/upper`,
          `${DOCKER_ROOT}/overlay/work`,
        ],
        mounts: [],
      },
      resourceKeys: ['container:container-a', 'quota:server-a:user-a'],
    });
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Updating,
      activeTaskId: 'task-1',
    });
  });

  it('queues a durable stop when desired stopped but the canonical runtime is running', async () => {
    await seedContainer('container-a', {
      desired: { powerIntent: ContainerPowerIntent.Stopped },
    });

    await service.reconcile(
      SERVER_ID,
      [snapshot('runtime-a', 'container-a', { status: ContainerStatus.Running })],
      DOCKER_ROOT,
    );

    expect(enqueued[0]).toMatchObject({
      kind: AgentTaskKind.ContainerStop,
      payload: { containerId: 'container-a', runtimeId: 'runtime-a' },
      resourceKeys: ['container:container-a'],
    });
    expect(await lifecycle('container-a')).toMatchObject({
      phase: ContainerPhase.Updating,
      activeTaskId: 'task-1',
    });
  });

  it.each([
    ContainerPowerIntent.Running,
    ContainerPowerIntent.Stopped,
  ].flatMap((powerIntent) => [
    ContainerStatus.Creating,
    ContainerStatus.Paused,
    ContainerStatus.Restarting,
    ContainerStatus.Unknown,
  ].map((status) => [powerIntent, status] as const)))(
    'fails closed for desired %s with unsupported authoritative power state %s',
    async (powerIntent, status) => {
      await seedContainer('container-a', { desired: { powerIntent } });

      const result = await service.reconcile(
        SERVER_ID,
        [snapshot('runtime-a', 'container-a', { status })],
        DOCKER_ROOT,
      );

      expect(result).toEqual({
        taskIds: [], failedContainerIds: ['container-a'], claimsChanged: false, quarantineReason: null,
      });
      expect(enqueued).toEqual([]);
      expect(await lifecycle('container-a')).toMatchObject({
        phase: ContainerPhase.Failed,
        activeTaskId: null,
        boundRuntimeId: 'runtime-a',
        failureCode: 'runtime_power_state_unsupported',
      });
    },
  );

  function snapshot(
    runtimeId: string,
    containerId: string,
    overrides: {
      runtimeSpecHash?: string;
      specGeneration?: string;
      status?: ContainerStatus;
      ip?: string;
    } = {},
  ): ContainerSnapshot {
    const specGeneration = overrides.specGeneration ?? '1';
    return {
      runtime: {
        runtimeId,
        ip: overrides.ip ?? '10.0.0.2',
        serverId: SERVER_ID,
        specGeneration,
        quotaPaths: [
          `${DOCKER_ROOT}/overlay2/${runtimeId}/diff`,
          `${DOCKER_ROOT}/overlay2/${runtimeId}/work`,
        ],
      },
      status: overrides.status ?? ContainerStatus.Running,
      sshServer: { enabled: false, status: 'disabled', user: 'root', port: 22 },
      labels: {
        [LABEL.MANAGED]: 'true',
        [LABEL.CONTAINER_ID]: containerId,
        [LABEL.SERVER_ID]: SERVER_ID,
        [LABEL.SPEC_GENERATION]: specGeneration,
        [LABEL.RUNTIME_SPEC_HASH]: overrides.runtimeSpecHash ?? HASH,
      },
    };
  }

  async function seedContainer(
    id: string,
    overrides: {
      container?: Partial<ContainerEntity>;
      lifecycle?: Partial<ContainerLifecycleEntity>;
      desired?: Partial<ContainerDesiredSpecEntity>;
    } = {},
  ): Promise<void> {
    const targetServerId = overrides.container?.serverId ?? SERVER_ID;
    if (!await dataSource.getRepository(ServerEntity).findOneBy({ id: targetServerId })) {
      await dataSource.getRepository(ServerEntity).save({
        id: targetServerId,
        name: targetServerId,
        slug: targetServerId,
        agentTokenHash: `token-${targetServerId}`,
        hostFingerprint: null,
        agentConfigFingerprint: null,
        status: ServerStatus.Offline,
        lastSeenAt: null,
        macvlanCidr: '10.0.0.0/24',
        macvlanGateway: '10.0.0.1',
        macvlanReservedIps: [],
      });
    }
    await dataSource.getRepository(ContainerEntity).save({
      id,
      serverId: SERVER_ID,
      ownerId: 'user-a',
      name: id,
      imageId: 'image-a',
      createdBy: 'user-a',
      ...overrides.container,
    });
    await dataSource.getRepository(ContainerDesiredSpecEntity).save({
      id: `desired-${id}`,
      containerId: id,
      generation: 1,
      imageRef: 'image:a',
      imageDefaultUid: 0,
      imageRuntimeOverrides: { uid: 0, entrypoint: null, cmd: null, init: false },
      cpuMillis: 1000,
      memBytes: 1024,
      diskBytes: 8192,
      gpuMode: 'none',
      gpuIndices: [],
      mountsJson: [],
      powerIntent: ContainerPowerIntent.Running,
      ...overrides.desired,
    });
    await dataSource.getRepository(ContainerLifecycleEntity).save({
      containerId: id,
      phase: ContainerPhase.Active,
      boundRuntimeId: 'runtime-a',
      quotaPathsJson: [
        `${DOCKER_ROOT}/overlay/upper`,
        `${DOCKER_ROOT}/overlay/work`,
      ],
      runtimeSpecHash: HASH,
      activeTaskId: null,
      lastTransitionAt: new Date(),
      failureReason: null,
      failureCode: null,
      ...overrides.lifecycle,
    });
    await dataSource.getRepository(NetworkAddressClaimEntity).save({
      id: `claim-${id}`,
      address: '10.0.0.2',
      networkKey: '10.0.0.0/24',
      ownerKind: 'container',
      ownerId: id,
      serverId: targetServerId,
      state: 'active',
      reusableAt: null,
    });
  }

  function pendingTask(
    id: string,
    kind: AgentTaskKind,
    resourceId: string,
    payloadJson: unknown,
  ): AgentTaskEntity {
    return {
      id,
      kind,
      serverId: SERVER_ID,
      resourceType: 'container',
      resourceId,
      requestedBy: null,
      requestJson: null,
      payloadJson,
      payloadHash: `hash-${id}`,
      admissionClass: 'normal',
      status: AgentTaskStatus.Pending,
      failureStage: null,
      agentResultJson: null,
      dispatchAttemptCount: 0,
      incompleteResultCount: 0,
      retryWindowStartedAt: null,
      nextDispatchAt: null,
      finalizerAttemptCount: 0,
      finalizerRetryAt: null,
      resultJson: null,
      errorJson: null,
      createdAt: new Date(),
      startedAt: null,
      lastSentAt: null,
      completedAt: null,
    };
  }

  function lifecycle(containerId: string): Promise<ContainerLifecycleEntity> {
    return dataSource.getRepository(ContainerLifecycleEntity).findOneByOrFail({ containerId });
  }
});
