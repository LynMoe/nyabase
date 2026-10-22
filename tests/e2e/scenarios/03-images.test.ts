// Image assignment per server and who may see which image.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ResourceLifecyclePhase,
  type AdminImageDto,
  type EffectiveAccessDto,
  type ImageAssignmentDto,
  type ImageDto,
  type IntentAcceptedDto,
} from '@nyabase/common';
import { ApiError } from '../client/api.js';
import { GIB, Harness } from '../client/harness.js';
import { pollUntil, waitIntent } from '../client/poll.js';

describe('image assignment and visibility', () => {
  let h: Harness;
  before(async () => {
    h = await Harness.start();
  });
  after(async () => h?.cleanup());

  it('has the test image active and ready on every server', async () => {
    const images = await h.api.get<AdminImageDto[]>('/images', { scope: 'all' });
    const image = images.find((entry) => entry.id === h.state.image.id);
    assert.ok(image, 'the image registered by up is listed');
    assert.equal(image.isActive, true);
    assert.ok(image.fingerprint, 'the catalog pinned a fingerprint');
    assert.equal(image.networkManagedExternally, true);
    for (const server of h.state.servers) {
      const assignment: ImageAssignmentDto | undefined = image.assignments.find((entry) => entry.serverId === server.id);
      assert.ok(assignment, `assigned on ${server.slug}`);
      assert.equal(assignment.lifecyclePhase, ResourceLifecyclePhase.Active);
      assert.equal(assignment.needsAttention, false);
      assert.equal(assignment.observedFingerprint, image.fingerprint);
    }
    const listed = await h.api.get<ImageAssignmentDto[]>(`/images/${image.id}/assignments`);
    assert.equal(listed.length, h.state.servers.length);
  });

  it('shows a user nothing without a grant and the image with one', async () => {
    const user = await h.newUser('img');
    const api = user.session.api;
    assert.deepEqual(await api.get<ImageDto[]>('/images'), []);
    assert.equal(await api.status('GET', `/images/${h.state.image.id}`), 403);

    await h.grantServer(user, h.server);
    const visible = await api.get<ImageDto[]>('/images');
    assert.deepEqual(visible.map((entry) => entry.id), [h.state.image.id]);
    assert.equal('assignments' in visible[0]!, false, 'the user view carries no assignment details');
    const access = await api.get<EffectiveAccessDto>('/me/access');
    assert.deepEqual(access.servers.map((entry) => entry.serverId), [h.server.id]);
    assert.ok(access.servers[0]!.allowedImageIds.includes(h.state.image.id));
  });

  it('keeps image administration to ManageImages holders', async () => {
    const user = await h.newUser('imgadm');
    const api = user.session.api;
    assert.equal(await api.status('GET', '/images?scope=all'), 403);
    assert.equal(await api.status('GET', '/images/catalog'), 403);
    assert.equal(await api.status('GET', `/images/${h.state.image.id}/assignments`), 403);
    assert.equal(await api.status('PUT', `/images/${h.state.image.id}/assignments/${h.server.id}`, {}), 403);
    assert.equal(await api.status('DELETE', `/images/${h.state.image.id}/assignments/${h.server.id}`), 403);
    assert.equal(await api.status('POST', '/images', { alias: h.state.image.alias }), 403);
  });

  it('stops offering the image once its assignment is removed, and restores it', async (t) => {
    const server = h.state.servers.at(-1)!;
    if (h.state.servers.length < 2) {
      t.skip('removing the only assignment would disturb the other scenarios; needs two servers');
      return;
    }
    const user = await h.newUser('imgdel');
    await h.grantServer(user, server);
    const api = user.session.api;
    assert.equal((await api.get<ImageDto[]>('/images')).length, 1);

    const removed = await h.api.delete<{ intents: IntentAcceptedDto[] }>(
      `/images/${h.state.image.id}/assignments/${server.id}`,
    );
    h.defer('restore image assignment', async () => {
      const restored = await h.api.put<{ intent: IntentAcceptedDto }>(
        `/images/${h.state.image.id}/assignments/${server.id}`,
        {},
      );
      await waitIntent(h.api, restored.intent, { timeoutMs: 900_000 });
    });
    for (const intent of removed.intents) await waitIntent(h.api, intent);
    await pollUntil(async () => ((await api.get<ImageDto[]>('/images')).length === 0 ? true : undefined),
      { what: 'the image to disappear for the user' });

    await assert.rejects(
      api.post('/containers', {
        serverId: server.id,
        imageId: h.state.image.id,
        name: h.name('noimg'),
        rootSizeBytes: h.state.rootSizeBytes,
        memBytes: GIB,
        powerIntent: 'stopped',
      }),
      (error: unknown) => error instanceof ApiError
        && [403, 409].includes(error.status) && error.code === 'IMAGE_NOT_AVAILABLE',
    );
  });
});
