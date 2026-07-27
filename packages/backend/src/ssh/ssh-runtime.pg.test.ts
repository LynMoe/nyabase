import { randomUUID } from 'node:crypto';
import {
  AgentTaskKind,
  ContainerPhase,
  ContainerPowerIntent,
  ContainerStatus,
  LABEL,
  ServerStatus,
  UserStatus,
  type ContainerSnapshot,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import {
  ContainerControlRepository,
  type NewContainerAggregate,
} from '../containers/container-control.repository.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ContainerSshConvergenceService } from './container-ssh-convergence.service.js';
import { ContainerSshRouteService } from './container-ssh-route.service.js';
import { SshIdentityService } from './ssh-identity.service.js';
import { SshProxySnapshotService } from './ssh-proxy-snapshot.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const HOST_FINGERPRINT = `SHA256:${'A'.repeat(43)}`;

describePg('PostgreSQL SSH route/snapshot/convergence', () => {
  it('builds the cold empty snapshot without issuing an empty PostgreSQL IN list', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const transactions = new PgTransactionManager(database);
      const repository = new ContainerControlRepository(database);
      const identities = new SshIdentityService(
        database,
        transactions,
        {
          generateEd25519: vi.fn(async () => ({
            privateKey: 'private-host',
            publicKey: 'public-host',
            fingerprint: HOST_FINGERPRINT,
          })),
        } as never,
        fakeCrypto() as never,
      );
      const snapshots = new SshProxySnapshotService(
        transactions,
        repository,
        identities,
        {
          get: (key: string) => key === 'ssh.proxySnapshotStaleMs'
            ? 120_000
            : key === 'ssh.proxyPublicHost'
              ? 'ssh.example.test'
              : 2222,
        } as never,
        { isServerBlocked: () => false } as never,
      );

      await expect(snapshots.buildSnapshot()).resolves.toMatchObject({
        users: [],
        servers: [],
        images: [],
        containers: [],
        routes: [],
      });
    });
  });

  it('publishes only a coherent active route from canonical PG state', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database);
      const routeService = new ContainerSshRouteService(
        fixture.repository,
        fixture.transactions,
      );
      await routeService.updateFromStateReport(
        fixture.serverId,
        [snapshot(fixture)],
        Date.now(),
      );
      const identities = new SshIdentityService(
        database,
        fixture.transactions,
        {
          generateEd25519: vi.fn(async () => ({
            privateKey: 'private-host',
            publicKey: 'public-host',
            fingerprint: HOST_FINGERPRINT,
          })),
        } as never,
        fakeCrypto() as never,
      );
      const snapshots = new SshProxySnapshotService(
        fixture.transactions,
        fixture.repository,
        identities,
        {
          get: (key: string) => key === 'ssh.proxySnapshotStaleMs'
            ? 120_000
            : key === 'ssh.proxyPublicHost'
              ? 'ssh.example.test'
              : 2222,
        } as never,
        { isServerBlocked: () => false } as never,
      );
      expect(await snapshots.buildSnapshot()).toMatchObject({
        users: [expect.objectContaining({ id: fixture.userId })],
        routes: [expect.objectContaining({
          containerId: fixture.containerId,
          runtimeId: 'runtime-a',
        })],
      });
      const current = (await fixture.repository.find(fixture.containerId))!;
      await fixture.transactions.run(async (transaction) => {
        await fixture.repository.transition(
          current.id,
          current.revision,
          { lifecyclePhase: ContainerPhase.Failed },
          transaction,
        );
      });
      expect((await snapshots.buildSnapshot()).routes).toEqual([]);
    });
  });

  it('queues one generation-fenced SSH ensure task for a stale route', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const fixture = await setup(database);
      await fixture.transactions.run((transaction) =>
        fixture.repository.upsertRoute({
          containerId: fixture.containerId,
          serverId: fixture.serverId,
          runtimeId: 'runtime-a',
          macvlanIp: '10.44.0.2',
          runtimeStatus: ContainerStatus.Running,
          sshStatus: 'unknown',
          appliedInternalKeyGeneration: null,
          containerHostKeyFingerprint: null,
          lastError: null,
          observedAt: new Date(),
        }, transaction));
      const codec = new AgentTaskPayloadCodecService({
        decryptIfEncrypted: (value: string) => value,
      } as never);
      const keys = new ResourceKeyService();
      const convergence = new ContainerSshConvergenceService(
        fixture.transactions,
        fixture.repository,
        new WorkflowEnqueuePort(keys, codec),
        keys,
      );
      await convergence.reconcileServer(fixture.serverId);
      expect(await database.selectFrom('workflow.tasks')
        .select(['kind', 'resource_id'])
        .execute()).toEqual([{
        kind: AgentTaskKind.ContainerSshEnsure,
        resource_id: fixture.containerId,
      }]);
      expect(await fixture.repository.find(fixture.containerId)).toMatchObject({
        lifecyclePhase: ContainerPhase.Updating,
        activeTaskId: expect.any(String),
      });
      await convergence.reconcileServer(fixture.serverId);
      expect(await database.selectFrom('workflow.tasks')
        .select('id').execute()).toHaveLength(1);
    });
  });
});

async function setup(database: any) {
  const userId = randomUUID();
  const serverId = randomUUID();
  const imageId = randomUUID();
  const containerId = randomUUID();
  await database.insertInto('iam.users').values({
    id: userId,
    numeric_id: 1001,
    username: 'alice',
    password_hash: 'hash',
    display_name: 'Alice',
    status: UserStatus.Active,
    auth_version: 0,
    authz_version: 0,
  }).execute();
  await database.insertInto('iam.user_internal_ssh_keys').values({
    user_id: userId,
    encrypted_private_key: 'enc:private-user',
    public_key: 'public-user',
    fingerprint: 'fingerprint-user',
    generation: 1,
    rotated_at: new Date(),
  }).execute();
  await database.insertInto('iam.ssh_public_keys').values({
    id: randomUUID(),
    user_id: userId,
    name: 'laptop',
    key_text: 'ssh-ed25519 AAAA laptop',
    fingerprint: 'fingerprint-laptop',
    created_at: new Date(),
  }).execute();
  await database.insertInto('infra.servers').values({
    id: serverId,
    name: 'Node',
    slug: `node-${serverId.slice(0, 8)}`,
    agent_token_hash: 'a'.repeat(64),
    host_fingerprint: 'host',
    agent_config_fingerprint: 'config',
    status: ServerStatus.Online,
    quarantine_code: null,
    quarantine_message: null,
    last_seen_at: new Date(),
    macvlan_cidr: '10.44.0.0/29',
    macvlan_gateway: '10.44.0.1',
    macvlan_reserved_ips: JSON.stringify([]),
    revision: 1,
  }).execute();
  const agentSessionId = randomUUID();
  const gatewayId = `gateway:test:${agentSessionId}`;
  const observedAt = new Date();
  await database.insertInto('workflow.agent_sessions').values({
    id: agentSessionId,
    server_id: serverId,
    generation: 1,
    session_token_hash: agentSessionId.replaceAll('-', '').padEnd(64, '0'),
    state: 'ready',
    host_fingerprint: 'host',
    config_fingerprint: 'config',
    gateway_id: gatewayId,
    console_public_url: 'wss://gateway.test/ws/console',
    lease_expires_at: new Date(observedAt.getTime() + 60_000),
    admitted_at: observedAt,
    ready_at: observedAt,
    last_seen_at: observedAt,
    retired_at: null,
    retire_reason: null,
  }).execute();
  await database.insertInto('workflow.agent_runtime_projections').values({
    server_id: serverId,
    session_id: agentSessionId,
    session_generation: 1,
    gateway_id: gatewayId,
    state_sequence: 1,
    runtime_ready: true,
    hello_json: JSON.stringify({ serverId }),
    state_report_json: JSON.stringify({ containers: [] }),
    docker_daemon_json: null,
    hello_observed_at: observedAt,
    state_observed_at: observedAt,
  }).execute();
  await database.insertInto('infra.images').values({
    id: imageId,
    name: 'Image',
    docker_image: 'example/image:latest',
    runtime_overrides: { uid: 0, entrypoint: null, cmd: null, init: false },
    description: null,
    is_active: true,
    disable_ssh: false,
    deleting: false,
    cleanup_generation: 0,
    revision: 1,
  }).execute();
  const transactions = new PgTransactionManager(database);
  const repository = new ContainerControlRepository(database);
  const aggregate: NewContainerAggregate = {
    id: containerId,
    serverId,
    ownerId: userId,
    imageId,
    createdBy: userId,
    name: 'work',
    imageRef: 'example/image:latest',
    imageDefaultUid: 0,
    imageRuntimeOverrides: {
      uid: 0,
      entrypoint: null,
      cmd: null,
      init: false,
    },
    cpuMillis: 1000,
    memBytes: 1024,
    diskBytes: 4096,
    gpuMode: 'none',
    gpuIndices: [],
    mountsJson: [],
    powerIntent: ContainerPowerIntent.Running,
    lifecyclePhase: ContainerPhase.Active,
  };
  await transactions.run(async (transaction) => {
    const inserted = await repository.insert(aggregate, transaction);
    await repository.transition(containerId, inserted.revision, {
      boundRuntimeId: 'runtime-a',
      quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
      runtimeSpecHash: 'a'.repeat(64),
      observedGeneration: 1,
    }, transaction);
    await repository.insertNetworkClaim({
      id: randomUUID(),
      containerId,
      serverId,
      networkKey: '10.44.0.0/29',
      address: '10.44.0.2',
    }, transaction);
  });
  return { database, transactions, repository, userId, serverId, imageId, containerId };
}

function snapshot(fixture: {
  serverId: string;
  containerId: string;
}): ContainerSnapshot {
  return {
    runtime: {
      runtimeId: 'runtime-a',
      ip: '10.44.0.2',
      serverId: fixture.serverId,
      specGeneration: '1',
      quotaPaths: ['/var/lib/docker/a', '/var/lib/docker/b'],
    },
    status: ContainerStatus.Running,
    sshServer: {
      enabled: true,
      status: 'running',
      user: 'root',
      port: 22,
      appliedKeyGeneration: 1,
      hostKeyFingerprint: HOST_FINGERPRINT,
    },
    labels: {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: fixture.containerId,
      [LABEL.SERVER_ID]: fixture.serverId,
      [LABEL.SPEC_GENERATION]: '1',
      [LABEL.RUNTIME_SPEC_HASH]: 'a'.repeat(64),
    },
  };
}

function fakeCrypto() {
  return {
    encrypt: (value: string) => `enc:${value}`,
    decrypt: (value: string) => value.replace(/^enc:/u, ''),
  };
}
