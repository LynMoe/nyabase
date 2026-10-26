import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_SOURCE_SERVER, Role, UserStatus } from '@nyabase/common';
import { IncusError } from '../incus/index.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { IntentRepository, type IntentRecord } from '../reconcile/intent.repository.js';
import { noopWake } from '../reconcile/reconcile-wake.test-helper.js';
import { seedContainer, seedImage, seedPool, seedServer, seedUser } from '../iam/access.pg-test-helper.js';
import { ImageAssignmentReconciler } from './image-assignment-reconciler.service.js';
import { ImageReconcileStore } from './image-reconcile.store.js';
import { ImagesService } from './images.service.js';
import { ImageVersionsService, recordImageVersion } from './image-versions.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const SPARE = 'c'.repeat(64);
const FOREIGN = 'd'.repeat(64);

type Db = Parameters<Parameters<typeof withPostgresTestDatabase>[0]>[0]['database'];
type FakeImage = { fingerprint: string; aliases: Array<{ name: string }>; used_by: string[] };

/** An Incus image store holding the given copies, the alias on the first one. */
function fakeIncus(alias: string, fingerprints: readonly string[]) {
  const images = new Map<string, FakeImage>(fingerprints.map((fingerprint, index) => [
    fingerprint,
    { fingerprint, aliases: index === 0 ? [{ name: alias }] : [], used_by: [] },
  ]));
  const ok = { status: 200, envelope: { type: 'sync', status: 'Success', status_code: 200, metadata: {} } };
  const client = {
    listImages: vi.fn(async () => ({ metadata: [...images.values()].map((image) => ({ ...image })) })),
    getImage: vi.fn(async (fingerprint: string) => {
      const image = images.get(fingerprint);
      if (!image) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure', {});
      return { metadata: { ...image } };
    }),
    deleteImage: vi.fn(async (fingerprint: string) => {
      images.delete(fingerprint);
      return ok;
    }),
    deleteImageAlias: vi.fn(async (name: string) => {
      for (const image of images.values()) image.aliases = image.aliases.filter((entry) => entry.name !== name);
      return ok;
    }),
    createImageAlias: vi.fn(async (body: { name: string; target: string }) => {
      images.get(body.target)!.aliases.push({ name: body.name });
      return ok;
    }),
  };
  return { client, images };
}

function runContext(intent: IntentRecord, client: unknown) {
  return { intent, client, claim: {}, lease: {}, signal: new AbortController().signal } as never;
}

async function seedAssignment(
  database: Db,
  input: { imageId: string; serverId: string; fingerprint: string },
): Promise<string> {
  const id = randomUUID();
  await database.insertInto('infra.image_server_assignments').values({
    id,
    image_id: input.imageId,
    server_id: input.serverId,
    revision: 1,
    observed_fingerprint: input.fingerprint,
    managed_fingerprint: input.fingerprint,
    lifecycle_phase: 'active',
    needs_attention: false,
    failure_code: null,
    failure_reason: null,
    last_observed_at: new Date(),
  }).execute();
  return id;
}

/** A copy nyabase pulled onto the server (ensures record these). */
async function recordCopy(database: Db, serverId: string, fingerprint: string): Promise<void> {
  await database.insertInto('infra.image_copies').values({ server_id: serverId, fingerprint }).execute();
}

function harness(database: Db, settings: Record<string, string> = {}) {
  const transactions = new PgTransactionManager(database);
  const intents = new IntentRepository(database, noopWake());
  const audit = { append: vi.fn(), log: vi.fn().mockResolvedValue(undefined) };
  const wake = { wake: vi.fn() };
  const reconciler = new ImageAssignmentReconciler(
    new ImageReconcileStore(database),
    {
      get: (key: string) => settings[key]
        ?? (key === 'incus.preflightSourceServer' ? DEFAULT_IMAGE_SOURCE_SERVER : ''),
    } as never,
    intents,
    audit as never,
    { register: vi.fn() } as never,
  );
  const versions = new ImageVersionsService(database, transactions, audit as never, wake as never);
  return { transactions, intents, audit, wake, reconciler, versions };
}

describePg('image versions', () => {
  it('repulls without touching old containers, refuses to delete a used or current version, then a scan removes the copy', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { transactions, intents, audit, wake, reconciler, versions } = harness(database);
      const operatorId = await seedUser(database, undefined, UserStatus.Active, Role.Operator);
      const ownerId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      const { alias } = await database.selectFrom('infra.images').select('alias').where('id', '=', imageId)
        .executeTakeFirstOrThrow();
      await recordImageVersion(database, imageId, OLD, 'v1');
      await seedAssignment(database, { imageId, serverId, fingerprint: OLD });
      await recordCopy(database, serverId, OLD);
      // seedContainer pins OLD.
      const containerId = await seedContainer(database, { ownerId, serverId, poolId, imageId, running: true });

      const catalog = { requireAlias: vi.fn(async () => ({ fingerprint: NEW, description: 'v2' })) };
      const images = new ImagesService(database, transactions, {} as never, audit as never, intents, catalog as never);
      const repulled = await images.repull(operatorId, imageId);
      expect(repulled.image.fingerprint).toBe(NEW);

      const { client, images: onServer } = fakeIncus(alias, [OLD, NEW]);
      await expect(reconciler.reconcile(runContext(repulled.intents[0]!, client)))
        .resolves.toEqual({ outcome: 'succeeded', observedRevision: 2 });
      // The container still runs from the old version, whose copy stays.
      expect(client.deleteImage).not.toHaveBeenCalled();
      expect(onServer.get(NEW)!.aliases).toEqual([{ name: alias }]);
      expect(onServer.get(OLD)!.aliases).toEqual([]);
      const container = await database.selectFrom('control.containers').select('image_fingerprint')
        .where('id', '=', containerId).executeTakeFirstOrThrow();
      expect(container.image_fingerprint).toBe(OLD);
      await reconciler.scan(serverId, client as never);
      expect([...onServer.keys()].sort()).toEqual([OLD, NEW]);

      const listed = await versions.list(imageId);
      expect(listed.map(({ fingerprint, description, current, deletable }) => ({
        fingerprint, description, current, deletable,
      }))).toEqual([
        { fingerprint: NEW, description: 'v2', current: true, deletable: false },
        { fingerprint: OLD, description: 'v1', current: false, deletable: false },
      ]);
      expect(listed[1]!.containers).toEqual([expect.objectContaining({
        id: containerId,
        ownerId,
        serverId,
        powerIntent: 'running',
        lifecyclePhase: 'active',
      })]);

      await expect(versions.delete(operatorId, imageId, NEW)).rejects.toMatchObject({
        response: { code: 'IMAGE_VERSION_CURRENT' },
      });
      await expect(versions.delete(operatorId, imageId, OLD)).rejects.toMatchObject({
        response: { code: 'IMAGE_VERSION_IN_USE', details: { containers: [expect.objectContaining({ id: containerId })] } },
      });
      // A parked or failed container still counts: it may need the copy to be recreated.
      await database.updateTable('control.containers')
        .set({ lifecycle_phase: 'failed', failure_code: 'TEST', failure_reason: 'parked' })
        .where('id', '=', containerId).execute();
      await expect(versions.delete(operatorId, imageId, OLD)).rejects.toMatchObject({
        response: { code: 'IMAGE_VERSION_IN_USE' },
      });

      await database.deleteFrom('control.containers').where('id', '=', containerId).execute();
      expect((await versions.list(imageId)).find((entry) => entry.fingerprint === OLD)?.deletable).toBe(true);
      await versions.delete(operatorId, imageId, OLD);
      expect(wake.wake).toHaveBeenCalledWith({ reason: 'scan' });
      expect((await versions.list(imageId)).map((entry) => entry.fingerprint)).toEqual([NEW]);
      await expect(versions.delete(operatorId, imageId, OLD)).rejects.toMatchObject({
        response: { code: 'IMAGE_VERSION_NOT_FOUND' },
      });

      // A scan that fails part way (server busy) leaves it to the next one.
      client.deleteImage.mockRejectedValueOnce(new IncusError('SERVER_UNREACHABLE', 'retry', {}));
      await reconciler.scan(serverId, client as never);
      expect(onServer.has(OLD)).toBe(true);
      await reconciler.scan(serverId, client as never);
      expect([...onServer.keys()]).toEqual([NEW]);
    });
  });

  it('removes kept versions from a server the image is no longer assigned to, except ones its containers use', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { reconciler } = harness(database);
      const ownerId = await seedUser(database);
      const serverId = await seedServer(database);
      const poolId = await seedPool(database, serverId);
      const imageId = await seedImage(database);
      await database.updateTable('infra.images').set({ fingerprint: NEW }).where('id', '=', imageId).execute();
      for (const fingerprint of [OLD, NEW, SPARE]) await recordImageVersion(database, imageId, fingerprint, null);
      // seedContainer pins OLD.
      await seedContainer(database, { ownerId, serverId, poolId, imageId });
      const { client, images: onServer } = fakeIncus('ubuntu', [NEW, OLD, SPARE, FOREIGN]);
      for (const fingerprint of [NEW, OLD, SPARE]) await recordCopy(database, serverId, fingerprint);

      // Assigned: every undeleted version stays.
      const assignmentId = await seedAssignment(database, { imageId, serverId, fingerprint: NEW });
      await reconciler.scan(serverId, client as never);
      expect(client.deleteImage).not.toHaveBeenCalled();

      // Unassigned: SPARE goes; OLD stays for the container, NEW is current, FOREIGN was never pulled here.
      await database.deleteFrom('infra.image_server_assignments').where('id', '=', assignmentId).execute();
      await reconciler.scan(serverId, client as never);
      expect(client.deleteImage).toHaveBeenCalledTimes(1);
      expect([...onServer.keys()].sort()).toEqual([OLD, NEW, FOREIGN].sort());
    });
  });

  it('never removes a copy nyabase did not pull onto that server, and keeps the preflight image', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { reconciler, versions } = harness(database, { 'incus.preflightImageFingerprint': SPARE });
      const operatorId = await seedUser(database, undefined, UserStatus.Active, Role.Operator);
      const assigned = await seedServer(database);
      const other = await seedServer(database);
      const imageId = await seedImage(database);
      await database.updateTable('infra.images').set({ fingerprint: NEW }).where('id', '=', imageId).execute();
      for (const fingerprint of [OLD, NEW, SPARE]) await recordImageVersion(database, imageId, fingerprint, null);
      await seedAssignment(database, { imageId, serverId: assigned, fingerprint: NEW });
      await versions.delete(operatorId, imageId, OLD);
      await versions.delete(operatorId, imageId, SPARE);
      // The other server's owner happens to cache the same public build.
      const { client: otherClient } = fakeIncus('ubuntu', [OLD]);
      await reconciler.scan(other, otherClient as never);
      expect(otherClient.deleteImage).not.toHaveBeenCalled();
      // On the assigned server OLD goes; SPARE is a deleted version but preflight is pinned to it.
      const { client, images: onServer } = fakeIncus('ubuntu', [NEW, OLD, SPARE]);
      for (const fingerprint of [NEW, OLD, SPARE]) await recordCopy(database, assigned, fingerprint);
      await reconciler.scan(assigned, client as never);
      expect([...onServer.keys()].sort()).toEqual([NEW, SPARE]);
    });
  });

  it('still removes the older copies of an image after the image itself is deleted', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { reconciler } = harness(database);
      const serverId = await seedServer(database);
      const imageId = await seedImage(database);
      await database.updateTable('infra.images').set({ fingerprint: NEW }).where('id', '=', imageId).execute();
      for (const fingerprint of [OLD, NEW]) {
        await recordImageVersion(database, imageId, fingerprint, null);
        await recordCopy(database, serverId, fingerprint);
      }
      const { client, images: onServer } = fakeIncus('ubuntu', [NEW, OLD]);
      // The image and its assignment are gone (the assignment's own deletion removed NEW's alias, not OLD).
      await database.deleteFrom('infra.images').where('id', '=', imageId).execute();
      await reconciler.scan(serverId, client as never);
      expect([...onServer.keys()]).toEqual([]);
      expect(await database.selectFrom('infra.image_copies').selectAll().execute()).toEqual([]);
    });
  });

  it('forgets copies that are gone from the server, but not ones recorded just now', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const serverId = await seedServer(database);
      await database.insertInto('infra.image_copies')
        .values({ server_id: serverId, fingerprint: OLD, recorded_at: new Date(Date.now() - 3_600_000) })
        .execute();
      await recordCopy(database, serverId, NEW);
      const store = new ImageReconcileStore(database);
      await store.forgetMissingCopies(serverId, []);
      const left = await database.selectFrom('infra.image_copies').select('fingerprint').execute();
      expect(left.map((row) => row.fingerprint)).toEqual([NEW]);
    });
  });

  it('pulling a deleted version again restores it, and a late ensure does not undo a repull', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const { reconciler, versions } = harness(database);
      const operatorId = await seedUser(database, undefined, UserStatus.Active, Role.Operator);
      const serverId = await seedServer(database);
      const imageId = await seedImage(database);
      await database.updateTable('infra.images').set({ fingerprint: NEW }).where('id', '=', imageId).execute();
      await recordImageVersion(database, imageId, OLD, 'v1');
      await recordImageVersion(database, imageId, NEW, 'v2');
      await seedAssignment(database, { imageId, serverId, fingerprint: NEW });
      await versions.delete(operatorId, imageId, OLD);
      await recordImageVersion(database, imageId, OLD, null);
      expect((await versions.list(imageId)).find((entry) => entry.fingerprint === OLD))
        .toMatchObject({ description: 'v1', deletable: true });

      const store = new ImageReconcileStore(database);
      const assignment = (await store.listScanAssignments(serverId))[0]!;
      await store.recordEnsured({ ...assignment, desired_fingerprint: OLD }, OLD);
      const image = await database.selectFrom('infra.images').select('fingerprint').where('id', '=', imageId)
        .executeTakeFirstOrThrow();
      expect(image.fingerprint).toBe(NEW);
      const { client } = fakeIncus('ubuntu', [NEW, OLD]);
      await reconciler.scan(serverId, client as never);
      expect(client.deleteImage).not.toHaveBeenCalled();
    });
  });
});
