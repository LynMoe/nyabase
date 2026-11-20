// System pools and root placement: any registered pool can take the system
// disk role; single placement moves it, random + sticky keeps a user on the
// pool holding their root disks until that pool reaches its high-water mark,
// and the root disk really lives on the chosen Incus pool.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  FailureCode,
  RootPlacement,
  type ContainerDto,
  type ServerDto,
  type StoragePoolDto,
} from '@nyabase/common';
import { Harness, type TestUser } from '../client/harness.js';
import { tryLoadState } from '../client/state.js';

const state = tryLoadState();
const skip = state && !state.servers.some((server) => server.dataPoolId)
  ? 'needs a second pool (E2E_SERVER_<n>_DATA_POOL in lab.env)'
  : false;

const ON = { weight: 1, maxUsedPercent: null };

describe('root placement across system pools', { skip }, () => {
  let h: Harness;
  let user: TestUser;
  let main: StoragePoolDto;
  let second: StoragePoolDto;
  let first: ContainerDto;

  const server = () => h.state.servers.find((entry) => entry.dataPoolId)!;
  const poolsPath = () => `/servers/${server().id}/storage-pools`;
  const pool = async (id: string) => {
    const found = (await h.api.get<StoragePoolDto[]>(poolsPath(), { scope: 'all' })).find((entry) => entry.id === id);
    if (!found) throw new Error(`pool ${id} not listed`);
    return found;
  };
  const patchPool = async (id: string, body: Record<string, unknown>) =>
    h.api.patch<StoragePoolDto>(`${poolsPath()}/${id}`, { expectedRevision: (await pool(id)).revision, ...body });
  const serverDto = () => h.api.get<ServerDto>(`/servers/${server().id}`, { scope: 'all' });
  const patchServer = async (body: Record<string, unknown>) =>
    h.api.patch<ServerDto>(`/servers/${server().id}`, { expectedRevision: (await serverDto()).revision, ...body });
  /** The pool Incus has the container's root disk on. */
  const rootPoolOnHost = async (container: ContainerDto) => {
    assert.ok(container.instanceName, 'the container has an Incus instance');
    return (await h.incus(server(), ['config', 'device', 'get', container.instanceName, 'root', 'pool'])).trim();
  };

  before(async () => {
    h = await Harness.start();
    main = await pool(server().poolId);
    second = await pool(server().dataPoolId!);
    assert.ok(main.systemDisk, 'the run starts with the main pool as the one system pool');
    assert.equal(second.systemDisk, null);
    // Back to single placement on the main pool, whatever a failed test left behind.
    h.defer('restore root placement', async () => {
      if ((await serverDto()).rootPlacement === RootPlacement.Random) {
        if ((await pool(second.id)).systemDisk) await patchPool(second.id, { systemDisk: null });
        if (!(await pool(main.id)).systemDisk) await patchPool(main.id, { systemDisk: ON });
        await patchServer({ rootPlacement: RootPlacement.Single });
      } else if (!(await pool(main.id)).systemDisk) {
        await patchPool(main.id, { systemDisk: ON });
      }
    });
    user = await h.newUser('placement');
    await h.grantServer(user, server());
  });
  after(async () => h?.cleanup());

  it('lets only administrators change a pool role', async () => {
    assert.equal(await user.session.api.status('PATCH', `${poolsPath()}/${second.id}`, {
      expectedRevision: second.revision,
      systemDisk: ON,
    }), 403);
  });

  it('moves the one system pool under single placement, and the root disk follows', async () => {
    const moved = await patchPool(second.id, { systemDisk: ON });
    assert.deepEqual(moved.systemDisk, ON);
    assert.equal((await pool(main.id)).systemDisk, null, 'single placement turned the old system pool off');
    assert.deepEqual((await serverDto()).systemPools.map((entry) => entry.id), [second.id]);

    first = await h.createContainer(user, server());
    assert.equal(first.rootPoolId, second.id);
    assert.equal(await rootPoolOnHost(first), second.incusName);
    const listed = await pool(second.id);
    assert.ok((listed.rootDisks?.count ?? 0) >= 1, 'the admin view counts the root disk on its pool');
  });

  it('keeps a sticky user on their pool under random placement, whatever the weights', async () => {
    const random = await patchServer({ rootPlacement: RootPlacement.Random, rootPlacementSticky: true });
    assert.equal(random.rootPlacement, RootPlacement.Random);
    assert.equal(random.rootPlacementSticky, true);
    await patchPool(main.id, { systemDisk: { weight: 100, maxUsedPercent: null } });
    assert.deepEqual(
      (await serverDto()).systemPools.map((entry) => entry.id).sort(),
      [main.id, second.id].sort(),
    );
    // Two system pools: single placement is refused until one is off.
    assert.equal(await h.api.status('PATCH', `/servers/${server().id}`, {
      expectedRevision: (await serverDto()).revision,
      rootPlacement: RootPlacement.Single,
    }), 409);

    const sticky = await h.createContainer(user, server());
    assert.equal(sticky.rootPoolId, second.id, 'the user stays where their root disk is, not on the heavier pool');
    assert.equal(await rootPoolOnHost(sticky), second.incusName);
  });

  it('skips a pool at its high-water mark, even the sticky one', async () => {
    const observed = await pool(second.id);
    assert.ok(observed.usedBytes !== null && observed.usedBytes > 0 && observed.totalBytes, 'the pool usage is known');
    const marked = await patchPool(second.id, { systemDisk: { weight: 1, maxUsedPercent: 1 } });
    assert.deepEqual(marked.systemDisk, { weight: 1, maxUsedPercent: 1 });

    const spilled = await h.createContainer(user, server());
    assert.equal(spilled.rootPoolId, main.id);
    assert.equal(await rootPoolOnHost(spilled), main.incusName);

    // With every system pool above its mark, creation says why per pool.
    await patchPool(main.id, { systemDisk: { weight: 1, maxUsedPercent: 1 } });
    const refused = await user.session.api.status('POST', '/containers', {
      serverId: server().id,
      imageId: h.state.image.id,
      name: h.name('full'),
      rootSizeBytes: h.state.rootSizeBytes,
      memBytes: 1024 ** 3,
      powerIntent: 'stopped',
    });
    assert.equal(refused, 409, FailureCode.StoragePoolExhausted);
  });

  it('turning the role off keeps the root disks on the pool', async () => {
    await patchPool(second.id, { systemDisk: null });
    const after = await pool(second.id);
    assert.equal(after.systemDisk, null);
    assert.ok((after.rootDisks?.count ?? 0) >= 2);
    const still = await user.session.api.get<ContainerDto>(`/containers/${first.id}`);
    assert.equal(still.rootPoolId, second.id);
  });
});
