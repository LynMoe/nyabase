import { randomUUID } from 'node:crypto';
import { ServerStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentTaskPayloadCodecService } from '../agent-tasks/agent-task-payload-codec.service.js';
import { ResourceKeyService } from '../agent-tasks/resource-key.service.js';
import { WorkflowEnqueuePort } from '../agent-tasks/workflow-enqueue.port.js';
import { WorkflowRepository } from '../agent-tasks/workflow.repository.js';
import { InfrastructureRepository } from '../infrastructure/infrastructure.repository.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../persistence-pg/transaction.js';
import { ImagesService } from './images.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('Images atomic audit PostgreSQL boundary', () => {
  it('rolls back pull task and claims when required audit append fails', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const imageId = randomUUID();
      const actorId = randomUUID();
      await database.insertInto('iam.users').values({
        id: actorId,
        numeric_id: 1001,
        username: 'image-auditor',
        password_hash: 'hash',
        display_name: 'Image Auditor',
        status: 'active',
        auth_version: 0,
        authz_version: 0,
      }).execute();
      await database.insertInto('infra.servers').values({
        id: serverId,
        name: 'Atomic Image Node',
        slug: `atomic-image-${serverId.slice(0, 8)}`,
        agent_token_hash: 'a'.repeat(64),
        host_fingerprint: null,
        agent_config_fingerprint: null,
        status: ServerStatus.Online,
        quarantine_code: null,
        quarantine_message: null,
        last_seen_at: new Date(),
        macvlan_cidr: null,
        macvlan_gateway: null,
        macvlan_reserved_ips: '[]',
        revision: 1,
      }).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'Atomic Image',
        docker_image: 'registry.example/atomic:latest',
        runtime_overrides: { uid: 0, entrypoint: null, cmd: null, init: false },
        description: null,
        is_active: true,
        disable_ssh: false,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      const transactions = new PgTransactionManager(database);
      const keys = new ResourceKeyService();
      const codec = new AgentTaskPayloadCodecService({
        decryptIfEncrypted: (value: string) => value,
      } as never);
      const infrastructure = new InfrastructureRepository(database);
      const service = new ImagesService(
        infrastructure,
        {} as never,
        new WorkflowEnqueuePort(keys, codec),
        new WorkflowRepository(database, transactions, codec),
        keys,
        { broadcastSnapshot: vi.fn() } as never,
        transactions,
        { append: vi.fn().mockRejectedValue(new Error('audit unavailable')) } as never,
        {
          assertActorCapabilitiesInTransaction: vi.fn().mockResolvedValue(new Set()),
        } as never,
      );
      const image = await infrastructure.findImageById(imageId);
      const result = await service.pullOnServers(actorId, image!, [serverId]);
      expect(result).toEqual({
        tasks: [],
        rejected: [{ serverId, message: 'audit unavailable' }],
      });
      expect(await database.selectFrom('workflow.tasks').select('id').execute()).toEqual([]);
      expect(await database.selectFrom('workflow.resource_claims')
        .select('resource_key').execute()).toEqual([]);
    });
  });
});
