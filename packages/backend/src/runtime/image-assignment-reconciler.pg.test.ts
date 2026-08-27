import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../persistence-pg/postgres-test-harness.js';
import { IntentRepository } from './intent.repository.js';
import { ImageAssignmentReconciler } from './image-assignment-reconciler.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const fingerprint = 'a'.repeat(64);

function serverValues(id: string) {
  return {
    id,
    name: 'image-reconciler-test-server',
    slug: `image-reconciler-${id.slice(0, 8)}`,
    api_endpoint: 'https://127.0.0.1:8443',
    server_cert_fingerprint: null,
    incus_version: null,
    api_extensions: [],
    system_pool_id: null,
    storage_overcommit_ratio: 1,
    parent_interface: null,
    dns_servers: [],
    gpu_runtime_available: false,
    status: 'online' as const,
    last_seen_at: new Date(),
    last_error: null,
    revision: 1,
    node_metrics_endpoint: null,
    node_metrics_server_cert_fingerprint: null,
    node_metrics_token_ciphertext: null,
    node_metrics_token_fingerprint: null,
    node_metrics_status: 'unconfigured' as const,
    node_metrics_last_success_at: null,
    node_metrics_outage_since: null,
    node_metrics_last_error: null,
    preflight_status: 'passed' as const,
    preflight_checked_at: new Date(),
    preflight_report: null,
  };
}

function incusImage() {
  return {
    fingerprint,
    aliases: [{ name: 'ubuntu' }],
    used_by: [],
  };
}

function syncResponse() {
  return {
    status: 200,
    envelope: {
      type: 'sync',
      status: 'Success',
      status_code: 200,
      metadata: {},
    },
  };
}

describePg('PostgreSQL image assignment cleanup and scan idempotency', () => {
  it('does not grow intents across settled scans and removes a settled deleting assignment', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const imageId = randomUUID();
      const assignmentId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'image-reconciler-image',
        alias: 'ubuntu',
        fingerprint,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: true,
        deleting: false,
        cleanup_generation: 0,
        revision: 1,
      }).execute();
      await database.insertInto('infra.image_server_assignments').values({
        id: assignmentId,
        image_id: imageId,
        server_id: serverId,
        generation: 1,
        observed_fingerprint: fingerprint,
        managed_fingerprint: fingerprint,
        lifecycle_phase: 'active',
        needs_attention: false,
        failure_code: null,
        failure_reason: null,
        last_observed_at: new Date(),
      }).execute();

      let physical = true;
      const client = {
        listImages: async () => ({ metadata: physical ? [incusImage()] : [] }),
        deleteImage: async () => {
          physical = false;
          return syncResponse();
        },
        getImage: async () => {
          if (!physical) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure', {});
          return { metadata: incusImage() };
        },
      };
      const intents = new IntentRepository(database);
      const reconciler = new ImageAssignmentReconciler(database, undefined, intents);

      await reconciler.scan(serverId, client as never);
      const first = await intents.list({
        resourceType: 'image_assignment',
        resourceId: assignmentId,
      });
      await intents.settleForObservedGeneration(
        'image_assignment',
        assignmentId,
        1,
        { outcome: 'succeeded' },
      );
      await reconciler.scan(serverId, client as never);
      const second = await intents.list({
        resourceType: 'image_assignment',
        resourceId: assignmentId,
      });
      expect(first.items).toHaveLength(1);
      expect(second.items).toHaveLength(1);

      await database.updateTable('infra.image_server_assignments')
        .set({
          generation: 2,
          lifecycle_phase: 'deleting',
        })
        .where('id', '=', assignmentId)
        .execute();
      await database.updateTable('infra.images')
        .set({ is_active: false, deleting: true, cleanup_generation: 1, revision: 2 })
        .where('id', '=', imageId)
        .execute();
      const deleteIntent = await intents.ensurePending({
        kind: 'image_assignment.delete',
        resourceType: 'image_assignment',
        resourceId: assignmentId,
        serverId,
        targetGeneration: 2,
        request: { operation: 'delete', imageId },
      });
      await expect(reconciler.reconcile({
        intent: deleteIntent,
        client: client as never,
        claim: {} as never,
        lease: {} as never,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        outcome: 'succeeded',
        observedGeneration: 2,
      });
      await intents.settleForObservedGeneration(
        'image_assignment',
        assignmentId,
        2,
        { outcome: 'succeeded' },
      );

      expect(await database.selectFrom('infra.image_server_assignments')
        .select('id')
        .where('id', '=', assignmentId)
        .execute()).toEqual([]);
      expect(await database.selectFrom('infra.images')
        .select('id')
        .where('id', '=', imageId)
        .execute()).toEqual([]);
      await reconciler.scan(serverId, client as never);
      expect(await intents.list({
        resourceType: 'image_assignment',
        resourceId: assignmentId,
      })).toMatchObject({ items: expect.any(Array) });
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', assignmentId)
        .execute()).toHaveLength(2);
    });
  });

  it('creates and settles a cleanup intent for an inactive image with no assignments', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = randomUUID();
      const imageId = randomUUID();
      await database.insertInto('infra.servers').values(serverValues(serverId)).execute();
      await database.insertInto('infra.images').values({
        id: imageId,
        name: 'orphaned-image',
        alias: 'orphaned',
        fingerprint: null,
        description: null,
        login_user: 'root',
        min_root_size_bytes: null,
        network_managed_externally: false,
        is_active: false,
        deleting: true,
        cleanup_generation: 1,
        revision: 2,
      }).execute();

      const intents = new IntentRepository(database);
      const reconciler = new ImageAssignmentReconciler(database, undefined, intents);
      const client = {
        listImages: async () => ({ metadata: [] }),
      };
      await reconciler.scan(serverId, client as never);
      const cleanupIntent = await intents.list({
        resourceType: 'image_assignment',
        resourceId: imageId,
      });
      expect(cleanupIntent.items).toHaveLength(1);
      expect(cleanupIntent.items[0]).toMatchObject({
        kind: 'image_assignment.delete',
        status: 'pending',
        request: expect.objectContaining({ operation: 'cleanup_image' }),
      });

      await expect(reconciler.reconcile({
        intent: cleanupIntent.items[0]!,
        client: client as never,
        claim: {} as never,
        lease: {} as never,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        outcome: 'succeeded',
        observedGeneration: 1,
      });
      await intents.settleForObservedGeneration(
        'image_assignment',
        imageId,
        1,
        { outcome: 'succeeded' },
      );
      await reconciler.scan(serverId, client as never);

      expect(await database.selectFrom('infra.images')
        .select('id')
        .where('id', '=', imageId)
        .execute()).toEqual([]);
      expect(await database.selectFrom('control.intents')
        .select('id')
        .where('resource_id', '=', imageId)
        .execute()).toHaveLength(1);
    });
  });
});
