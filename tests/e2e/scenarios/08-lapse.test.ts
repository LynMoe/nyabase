// Revoking a grant starts the 14-day grace at once and stops the user's
// containers; only after the grace are the resources purged. The purge is
// driven by moving `lapsed_at` into the past in the run's database, so the
// production code carries no test switch. Disabling a user is a loss of
// coverage like a revocation: same grace, stop and purge.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ContainerPowerIntent,
  ContainerStatus,
  UserStatus,
  type ContainerDto,
  type EffectiveAccessDto,
  type IntentAcceptedDto,
} from '@nyabase/common';
import { psql, uuid } from '../client/db.js';
import { GIB, Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';

describe('lapse: revoke, grace, purge and disable', () => {
  let h: Harness;
  const serverId = () => h.server.id;
  const lapseRow = (user: TestUser) => psql(h.state.databaseUrl, `
    SELECT stopped_at IS NOT NULL, purged_at IS NOT NULL, lapsed_at > now() - interval '10 minutes'
    FROM control.access_lapses
    WHERE user_id = '${uuid(user.id)}' AND resource_kind = 'server' AND resource_id = '${uuid(serverId())}'
  `)[0];
  const asAdmin = (id: string) => h.api.get<ContainerDto>(`/containers/${id}`, { scope: 'all' });

  before(async () => {
    h = await Harness.start();
  });
  after(async () => h?.cleanup());

  it('revoking a grant opens the grace, stops containers and keeps everything else', async () => {
    const user = await h.newUser('lapse');
    await h.grantServer(user, h.server);
    await h.grantPool(user, h.server.poolId);
    const container = await h.createContainer(user, h.server);
    const volume = await user.session.api.post<IntentAcceptedDto>('/volumes', {
      name: h.name('keep'),
      sizeBytes: GIB,
      scope: { kind: 'local', serverId: serverId(), poolId: h.server.poolId },
    });
    h.defer('delete lapse volume', () => h.deleteVolume(h.api, volume.resourceId));
    await pollUntil(async () => (await user.session.api.status('GET', `/volumes/${volume.resourceId}`)) === 200 ? true : undefined,
      { what: 'the volume row' });
    assert.equal(lapseRow(user), undefined, 'no ledger row while covered');

    await h.api.delete(`/users/${user.id}/server-grants/${serverId()}`);
    assert.deepEqual((await user.session.api.get<EffectiveAccessDto>('/me/access')).servers, []);
    const opened = await pollUntil(async () => {
      const row = lapseRow(user);
      return row && row[0] === 't' ? row : undefined;
    }, { what: 'the grace to open and containers to be stopped', timeoutMs: 240_000, intervalMs: 3_000 });
    assert.deepEqual(opened, ['t', 'f', 't'], 'stopped, not purged, lapsed just now');

    const stopped = await h.waitContainer(h.api, container.id, (c) => c.actual.status === ContainerStatus.Stopped,
      'the lapsed container to stop');
    assert.equal(stopped.powerIntent, ContainerPowerIntent.Stopped);
    assert.equal(await user.session.api.status('POST', `/containers/${container.id}/actions/start`), 403,
      'the owner cannot restart it without coverage');
    assert.equal(await user.session.api.status('GET', `/volumes/${volume.resourceId}`), 200);

    // Coverage back inside the grace cancels it; the container stays stopped.
    await h.grantServer(user, h.server);
    await pollUntil(async () => (lapseRow(user) === undefined ? true : undefined),
      { what: 'the grace to be cleared', timeoutMs: 240_000, intervalMs: 3_000 });
    assert.equal((await asAdmin(container.id)).actual.status, ContainerStatus.Stopped);

    // Revoke again, then age the grace past 14 days and let the processor purge.
    await h.api.delete(`/users/${user.id}/server-grants/${serverId()}`);
    await pollUntil(async () => lapseRow(user)?.[0] === 't' ? true : undefined,
      { what: 'the grace to reopen', timeoutMs: 240_000, intervalMs: 3_000 });
    psql(h.state.databaseUrl, `
      UPDATE control.access_lapses SET lapsed_at = now() - interval '15 days'
      WHERE user_id = '${uuid(user.id)}' AND resource_kind = 'server' AND resource_id = '${uuid(serverId())}'
    `);
    // Any IAM write wakes the processor right away; otherwise its minute timer does.
    await h.api.put(`/users/${user.id}/storage-pool-grants/${h.server.poolId}`, { expiresAt: null });
    await pollUntil(async () => (await h.api.status('GET', `/containers/${container.id}?scope=all`)) === 404 ? true : undefined,
      { what: 'the container to be purged', timeoutMs: 420_000, intervalMs: 5_000 });
    await pollUntil(async () => (await h.api.status('GET', `/volumes/${volume.resourceId}?scope=all`)) === 404 ? true : undefined,
      { what: 'the volume to be purged', timeoutMs: 300_000, intervalMs: 5_000 });
    assert.equal((await h.api.get<{ id: string }>(`/users/${user.id}`)).id, user.id, 'the account itself stays');
  });

  it('disabling a user opens the grace like a revocation; re-enabling cancels it, then the purge follows', async () => {
    const user = await h.newUser('disabled');
    await h.grantServer(user, h.server);
    const container = await h.createContainer(user, h.server);
    assert.equal(lapseRow(user), undefined, 'no ledger row while active');

    await h.api.patch(`/users/${user.id}`, { status: UserStatus.Disabled });
    const opened = await pollUntil(async () => {
      const row = lapseRow(user);
      return row && row[0] === 't' ? row : undefined;
    }, { what: 'the grace to open for the disabled user', timeoutMs: 240_000, intervalMs: 3_000 });
    assert.deepEqual(opened, ['t', 'f', 't'], 'stopped, not purged, lapsed just now');
    await h.waitContainer(h.api, container.id, (c) => c.actual.status === ContainerStatus.Stopped,
      'the disabled user\'s container to stop', 240_000);

    // Re-enabled inside the grace: the row goes away and the container stays stopped.
    await h.api.patch(`/users/${user.id}`, { status: UserStatus.Active });
    await pollUntil(async () => (lapseRow(user) === undefined ? true : undefined),
      { what: 'the grace to be cleared', timeoutMs: 240_000, intervalMs: 3_000 });
    const kept = await h.waitContainer(h.api, container.id, (c) => c.actual.status === ContainerStatus.Stopped,
      'the container to stay stopped after re-enabling');
    assert.equal(kept.powerIntent, ContainerPowerIntent.Stopped);

    // Disable again, age the grace past 14 days; the status change wakes the processor.
    await h.api.patch(`/users/${user.id}`, { status: UserStatus.Disabled });
    await pollUntil(async () => (lapseRow(user) ? true : undefined),
      { what: 'the grace to reopen', timeoutMs: 240_000, intervalMs: 3_000 });
    psql(h.state.databaseUrl, `
      UPDATE control.access_lapses SET lapsed_at = now() - interval '15 days'
      WHERE user_id = '${uuid(user.id)}' AND resource_kind = 'server' AND resource_id = '${uuid(serverId())}'
    `);
    await h.api.patch(`/users/${user.id}`, { status: UserStatus.Disabled }); // no-op; the timer picks it up
    await pollUntil(async () => (await h.api.status('GET', `/containers/${container.id}?scope=all`)) === 404 ? true : undefined,
      { what: 'the disabled user\'s container to be purged', timeoutMs: 420_000, intervalMs: 5_000 });
    assert.equal((await h.api.get<{ id: string }>(`/users/${user.id}`)).id, user.id, 'the account itself stays');
  });
});
