import { describe, expect, it, vi, type Mock } from 'vitest';
import { AuditAction, FailureCode, IntentKind, IntentResourceType, IntentStatus } from '@nyabase/common';
import {
  buildDesiredInstanceSpec,
  deriveAttachmentDeviceName,
  deriveInstanceName,
  deriveVolumeName,
  IncusError,
  type DesiredInstanceSpec,
} from '../incus/index.js';
import { ContainerReconciler, rootQuotaRetryDelay } from './container-reconciler.service.js';
import { ContainerReconcileStore } from './container-reconcile.store.js';
import {
  managedContainerIdentity,
  observedDiskUsageBytes,
  powerTransition,
  restartTransition,
} from './container-instance-ops.js';
import { decideRootShrink } from './container-rules.js';
import type { IntentRecord } from '../reconcile/intent.repository.js';
import { VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS } from '../volumes/shared-volume-catalog.service.js';
import type { ReconcileRunContext } from '../reconcile/managed-reconciler.js';
import {
  IncusContainerSshStateAdapter,
  MANAGED_KEYS_BEGIN,
  MANAGED_KEYS_END,
  reconcileSshFile,
  sshFileMetadataMatches,
  sshFileNeedsReconcile,
  sshObservation,
  withManagedKeys,
} from './container-ssh.js';

/** The reconciler's private SQL store, where the tests intercept data access. */
function storeOf(reconciler: ContainerReconciler): object {
  return (reconciler as unknown as { store: object }).store;
}

const CONTAINER_ID = '11111111-1111-4111-8111-111111111111';
const SERVER_ID = '22222222-2222-4222-8222-222222222222';
const ATTACH_KEEP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTACH_REMOVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTACH_ADD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VOLUME_KEEP = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const VOLUME_REMOVE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const VOLUME_ADD = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const IMAGE_FINGERPRINT = 'b'.repeat(64);
const ROUTED_IP = '198.51.100.10';
const PARENT = 'ens3';
const ROOT_POOL = 'default';

describe('container reconciliation identity and power policy', () => {
  it('treats unknown or negative Incus disk usage as unset', () => {
    expect(observedDiskUsageBytes(-1)).toBeNull();
    expect(observedDiskUsageBytes(Number.NaN)).toBeNull();
    expect(observedDiskUsageBytes('')).toBeNull();
    expect(observedDiskUsageBytes(0)).toBe(0n);
    expect(observedDiskUsageBytes(1_000_000_000)).toBe(1_000_000_000n);
    expect(observedDiskUsageBytes('42')).toBe(42n);
  });

  it('requires the three managed identity fields before treating an instance as owned', () => {
    expect(managedContainerIdentity({
      config: {
        'user.nyabase.managed': 'true',
        'user.nyabase.container_id': 'aabb',
        'user.nyabase.server_id': 'cc-dd',
      },
    })).toEqual({
      managed: true,
      containerId: 'aabb',
      serverId: 'ccdd',
    });
    expect(managedContainerIdentity({
      config: { 'user.nyabase.container_id': 'aabb' },
    }).managed).toBe(false);
  });

  it('only emits power mutations when the observed state differs', () => {
    expect(powerTransition('Running', 'running')).toBe('none');
    expect(powerTransition('Stopped', 'running')).toBe('start');
    expect(powerTransition('Running', 'stopped')).toBe('stop');
    expect(powerTransition('Frozen', 'stopped')).toBe('none');
  });

  it('uses started_at as the restart proof baseline', () => {
    expect(restartTransition('old', 'old', 'Running')).toBe('restart');
    expect(restartTransition('new', 'old', 'Running')).toBe('proven');
    expect(restartTransition(null, null, 'Stopped')).toBe('restart');
  });

  it('treats SSH metadata drift as drift even when the content hash is unchanged', () => {
    const content = 'ssh-ed25519 AAAA fixture\n';
    const desiredMetadata = {
      uid: 1000,
      gid: 1000,
      mode: 0o600,
      type: 'file' as const,
    };
    const actual = {
      body: Buffer.from(content),
      ...desiredMetadata,
    };

    expect(sshFileNeedsReconcile({
      actual,
      desiredContent: content,
      desiredMetadata,
    })).toBe(false);
    expect(sshFileNeedsReconcile({
      actual: { ...actual, mode: 0o644 },
      desiredContent: content,
      desiredMetadata,
    })).toBe(true);
    expect(sshFileMetadataMatches(
      { ...desiredMetadata, uid: 1001 },
      desiredMetadata,
    )).toBe(false);
  });

  it('rewrites only the managed authorized_keys block and keeps the user lines', () => {
    const platform = 'ssh-ed25519 AAAAplatform alice';
    const block = `${MANAGED_KEYS_BEGIN}\n${platform}\n${MANAGED_KEYS_END}\n`;
    expect(withManagedKeys('', platform)).toBe(block);
    const user = 'ssh-ed25519 AAAAdeploy ci\n';
    const written = withManagedKeys(user, platform);
    expect(written).toBe(`ssh-ed25519 AAAAdeploy ci\n${block}`);
    expect(withManagedKeys(written, platform)).toBe(written);
    // Keys removed: the block goes, the user's key stays.
    expect(withManagedKeys(written, null)).toBe(user);
    // The block moves to the end; a missing end marker drops everything after the start.
    expect(withManagedKeys(`${block}ssh-rsa AAAAlater\n`, 'ssh-ed25519 AAAAnew'))
      .toBe(`ssh-rsa AAAAlater\n${MANAGED_KEYS_BEGIN}\nssh-ed25519 AAAAnew\n${MANAGED_KEYS_END}\n`);
    expect(withManagedKeys(`ssh-rsa AAAAkeep\n${MANAGED_KEYS_BEGIN}\nssh-ed25519 AAAAstale\n`, null))
      .toBe('ssh-rsa AAAAkeep\n');
    expect(withManagedKeys('', null)).toBe('');
  });

  it('removes revoked platform keys from the guest and creates no file without keys', async () => {
    const sshState = new IncusContainerSshStateAdapter();
    const files = new Map<string, string>();
    vi.spyOn(sshState, 'readAuthorizedKeys').mockImplementation(async (_client, _name, path) => {
      const body = files.get(path);
      if (path === '/home/dev/.ssh/authorized_keys') return { body: Buffer.from('/home/dev/dotfiles/keys'), type: 'symlink' } as never;
      return body === undefined ? null : { body: Buffer.from(body, 'latin1'), uid: 0, gid: 0, mode: 0o600, type: 'file' } as never;
    });
    const write = vi.spyOn(sshState, 'writeAuthorizedKeys')
      .mockImplementation(async (_client, _name, path, content) => { files.set(path, Buffer.from(content).toString('latin1')); });
    const row = { login_user: 'root', ssh_public_key: null } as never;
    const signal = new AbortController().signal;
    await expect(reconcileSshFile(sshState, {} as never, row, 'nyc-x', false, signal))
      .resolves.toEqual({ status: 'disabled', lastError: null });
    expect(write).not.toHaveBeenCalled();

    files.set('/root/.ssh/authorized_keys', `ssh-rsa AAAAmine\n${withManagedKeys('', 'ssh-ed25519 AAAAold')}`);
    await expect(reconcileSshFile(sshState, {} as never, row, 'nyc-x', false, signal))
      .resolves.toEqual({ status: 'disabled', lastError: null });
    expect(files.get('/root/.ssh/authorized_keys')).toBe('ssh-rsa AAAAmine\n');

    // Bytes that are not UTF-8 in a user line survive the rewrite unchanged.
    files.set('/root/.ssh/authorized_keys', 'ssh-rsa AAAAmine caf\xe9\n');
    const withKey = { login_user: 'root', ssh_public_key: 'ssh-ed25519 AAAAnew' } as never;
    await reconcileSshFile(sshState, {} as never, withKey, 'nyc-x', false, signal);
    expect(files.get('/root/.ssh/authorized_keys')).toBe(`ssh-rsa AAAAmine caf\xe9\n${withManagedKeys('', 'ssh-ed25519 AAAAnew')}`);

    // A symlinked authorized_keys is never written through.
    write.mockClear();
    const linked = { login_user: 'dev', ssh_public_key: 'ssh-ed25519 AAAAnew' } as never;
    await expect(reconcileSshFile(sshState, {} as never, linked, 'nyc-x', false, signal))
      .resolves.toEqual({ status: 'error', lastError: 'authorized_keys_not_a_file' });
    expect(write).not.toHaveBeenCalled();
  });

  it('records a visible error when sshd is missing after key convergence', () => {
    expect(sshObservation('missing')).toEqual({
      status: 'error',
      lastError: 'key_applied_sshd_missing',
    });
    expect(sshObservation('present')).toEqual({
      status: 'running',
      lastError: null,
    });
  });
});

describe('container reconciler §15.1 fixture-driven Incus mocks', () => {
  it('does not emit any Incus PUT when the managed document is already converged', async () => {
    const { reconciler, client, putBodies, expectedName } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: {
        config: {
          'volatile.eth0.hwaddr': '02:aa:bb:cc:dd:ee',
          'image.os': 'ubuntu',
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(client.updateInstance).not.toHaveBeenCalled();
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(client.updateInstanceState).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
    expect(client.getInstanceFull).toHaveBeenCalledWith(expectedName);
  });

  it('PUT path keeps Incus-owned config and strips operator config and devices', async () => {
    const { reconciler, client, putBodies, store } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: {
        config: {
          'limits.cpu': '4',
          'volatile.eth0.hwaddr': '02:aa:bb:cc:dd:ee',
          'operator.note': 'keep-operator',
          'image.os': 'ubuntu',
        },
        devices: {
          operatorDisk: {
            type: 'disk',
            source: 'operator-volume',
            path: '/operator',
          },
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.readModifyWriteInstance).toHaveBeenCalledTimes(1);
    expect(putBodies).toHaveLength(1);
    const put = putBodies[0]!;
    expect(put.config['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(put.config['operator.note']).toBeUndefined();
    expect(put.config['image.os']).toBe('ubuntu');
    expect(put.config['limits.cpu']).toBe('0-1');
    expect(put.config['security.privileged']).toBe('false');
    expect(put.config['security.idmap.isolated']).toBe('true');
    expect(put.devices.operatorDisk).toBeUndefined();
    expect(store.document.config?.['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(store.document.devices?.operatorDisk).toBeUndefined();
  });

  it('applies add-device and remove-device in the same reconcile PUT', async () => {
    const removeName = deriveAttachmentDeviceName(ATTACH_REMOVE);
    const addName = deriveAttachmentDeviceName(ATTACH_ADD);
    const keepName = deriveAttachmentDeviceName(ATTACH_KEEP);
    const { reconciler, client, putBodies, store } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [
        attachment(ATTACH_KEEP, VOLUME_KEEP, '/data/keep'),
        attachment(ATTACH_ADD, VOLUME_ADD, '/data/add'),
      ],
      documentExtras: {
        devices: {
          [keepName]: diskDevice(VOLUME_KEEP, '/data/keep'),
          [removeName]: diskDevice(VOLUME_REMOVE, '/data/remove'),
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.readModifyWriteInstance).toHaveBeenCalledTimes(1);
    const put = putBodies[0]!;
    expect(put.devices[removeName]).toBeUndefined();
    expect(put.devices[addName]).toMatchObject({
      type: 'disk',
      path: '/data/add',
      source: deriveVolumeName(VOLUME_ADD),
    });
    expect(put.devices[keepName]).toMatchObject({
      type: 'disk',
      path: '/data/keep',
      source: deriveVolumeName(VOLUME_KEEP),
    });
    expect(store.document.devices?.[removeName]).toBeUndefined();
    expect(store.document.devices?.[addName]).toBeDefined();
  });

  it('retries when a custom volume is missing before PUT', async () => {
    const { reconciler, client } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add')],
    });
    client.getStorageVolume.mockRejectedValueOnce(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
    );

    await expect(reconciler.reconcile(context(client))).rejects.toMatchObject({
      code: 'VOLUME_PLACEMENT_PENDING',
      disposition: 'retry',
    });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
  });

  it('retries PUT TOCTOU missing-volume 400 as VOLUME_PLACEMENT_PENDING', async () => {
    const removeName = deriveAttachmentDeviceName(ATTACH_REMOVE);
    const { reconciler, client } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add')],
      documentExtras: {
        devices: {
          [removeName]: diskDevice(VOLUME_REMOVE, '/data/remove'),
        },
      },
    });
    client.readModifyWriteInstance.mockRejectedValueOnce(
      new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
        error: 'Failed to start device: Storage volume not found',
      }),
    );

    await expect(reconciler.reconcile(context(client))).rejects.toMatchObject({
      code: 'VOLUME_PLACEMENT_PENDING',
      disposition: 'retry',
    });
  });

  it('adopts a missing shared catalog instead of VOLUME_PLACEMENT_PENDING', async () => {
    const { reconciler, client } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching', true)],
    });
    client.getStorageVolume
      .mockRejectedValueOnce(new IncusError('INCUS_NOT_FOUND', 'managed_failure'))
      .mockResolvedValue(syncResponse({ name: 'volume' }));

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.createStorageVolume).toHaveBeenCalledWith(
      ROOT_POOL,
      expect.objectContaining({
        name: deriveVolumeName(VOLUME_ADD),
        config: expect.objectContaining({
          'security.shifted': 'true',
        }),
      }),
      expect.anything(),
    );
  });

  it('skips nyd-* PUT when cancel happens after mkdir and before present write', async () => {
    const addName = deriveAttachmentDeviceName(ATTACH_ADD);
    const rows = [
      attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching', true),
    ];
    const { reconciler, client, putBodies } = await harness({
      status: 'Running',
      powerIntent: 'running',
      attachments: rows,
    });
    let revision = 3;
    vi.spyOn(
      storeOf(reconciler) as unknown as { readContainer: () => Promise<unknown> },
      'readContainer',
    ).mockImplementation(async () => containerRow({
      status: 'Running',
      powerIntent: 'running',
    }));
    vi.spyOn(
      storeOf(reconciler) as unknown as { rereadDesired: () => Promise<unknown> },
      'rereadDesired',
    ).mockImplementation(async () => {
      const desired = rows
        .filter((item) => item.bindState !== 'detaching')
        .map((item) => attachmentRows([item])[0]);
      return { stale: revision > 3, desired };
    });
    client.getStorageVolume.mockRejectedValueOnce(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
    );
    client.createStorageVolume.mockImplementation(async () => {
      rows[0] = { ...rows[0]!, bindState: 'detaching' };
      revision = 4;
      return syncResponse({});
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.createStorageVolume).toHaveBeenCalled();
    const nydPuts = putBodies.filter((body) => body.devices[addName]);
    expect(nydPuts).toHaveLength(0);
  });

  it('retries attaching catalogs that are missing, but not detaching-only updates', async () => {
    const addName = deriveAttachmentDeviceName(ATTACH_ADD);
    const removeName = deriveAttachmentDeviceName(ATTACH_REMOVE);
    const attaching = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching')],
    });
    attaching.client.getStorageVolume.mockRejectedValueOnce(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
    );
    await expect(attaching.reconciler.reconcile(context(attaching.client))).rejects.toMatchObject({
      code: 'VOLUME_PLACEMENT_PENDING',
      disposition: 'retry',
    });
    expect(attaching.client.readModifyWriteInstance).not.toHaveBeenCalled();

    const detaching = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_REMOVE, VOLUME_REMOVE, '/data/remove', 'detaching')],
      documentExtras: {
        devices: {
          [removeName]: diskDevice(VOLUME_REMOVE, '/data/remove'),
        },
      },
    });
    detaching.client.getStorageVolume.mockRejectedValue(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
    );
    const outcome = await detaching.reconciler.reconcile(context(detaching.client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(detaching.client.readModifyWriteInstance).toHaveBeenCalledTimes(1);
    expect(detaching.putBodies[0]!.devices[removeName]).toBeUndefined();
    expect(detaching.putBodies[0]!.devices[addName]).toBeUndefined();
  });

  it('succeeds a stale container.update without PUT or bind settlement', async () => {
    const { reconciler, client } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching')],
    });
    const outcome = await reconciler.reconcile(context(client, { targetRevision: 2 }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 2, stale: true });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(client.getStorageVolume).not.toHaveBeenCalled();
  });

  it('settles attaching to attached after the device is present and drops detaching after it is gone', async () => {
    const addName = deriveAttachmentDeviceName(ATTACH_ADD);
    const removeName = deriveAttachmentDeviceName(ATTACH_REMOVE);
    const binds = volumeBindDb([
      { id: ATTACH_ADD, bind_state: 'attaching', device_name: addName },
      { id: ATTACH_REMOVE, bind_state: 'detaching', device_name: removeName },
    ]);
    const { reconciler, client, putBodies } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      database: binds.db,
      attachments: [
        attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching'),
        attachment(ATTACH_REMOVE, VOLUME_REMOVE, '/data/remove', 'detaching'),
      ],
      documentExtras: {
        devices: {
          [removeName]: diskDevice(VOLUME_REMOVE, '/data/remove'),
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    // The detaching device is unplugged on its own first, then the spec is applied.
    expect(putBodies).toHaveLength(2);
    expect(putBodies[0]!.devices[removeName]).toBeUndefined();
    expect(putBodies[1]!.devices[addName]).toMatchObject({
      type: 'disk',
      path: '/data/add',
      source: deriveVolumeName(VOLUME_ADD),
    });
    expect(putBodies[1]!.devices[removeName]).toBeUndefined();
    expect(binds.updated).toContain(ATTACH_ADD);
    expect(binds.deleted).toContain(ATTACH_REMOVE);
  });

  it('does not create a second instance for the same container_id after a crash window', async () => {
    const { reconciler, client, expectedName } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
    });

    const first = await reconciler.reconcile(context(client));
    const second = await reconciler.reconcile(context(client));
    expect(first).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(second).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(client.getInstanceFull).toHaveBeenCalledWith(expectedName);
    expect(client.listInstances).not.toHaveBeenCalled();
  });

  it('fails closed when the expected name is occupied by another managed instance', async () => {
    const occupantId = '99999999-9999-4999-8999-999999999999';
    const { reconciler, client } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: {
        config: {
          'user.nyabase.container_id': occupantId,
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { code: 'MANAGED_INSTANCE_IDENTITY_MISMATCH' },
    });
    expect(client.deleteInstance).not.toHaveBeenCalled();
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
  });

  it('fails closed when eth0 is not bridged and never writes Incus', async () => {
    const { reconciler, client, putBodies } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: {
        devices: {
          eth0: {
            type: 'nic',
            nictype: 'routed',
            parent: PARENT,
            name: 'eth0',
          },
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { code: 'INVALID_MANAGED_NETWORK_TYPE' },
    });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(client.updateInstance).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
  });

  it('fails closed when leftover eth0 is macvlan and never writes Incus', async () => {
    const { reconciler, client, putBodies } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: {
        devices: {
          eth0: {
            type: 'nic',
            nictype: 'macvlan',
            mode: 'bridge',
            parent: PARENT,
            name: 'eth0',
          },
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { code: 'INVALID_MANAGED_NETWORK_TYPE' },
    });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
  });

  it('repairs a bridged eth0 missing hwaddr or filter keys', async () => {
    const { reconciler, client, putBodies } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: {
        devices: {
          eth0: {
            type: 'nic',
            nictype: 'bridged',
            parent: PARENT,
            name: 'eth0',
            'ipv4.address': ROUTED_IP,
            'security.ipv4_filtering': 'true',
            'security.mac_filtering': 'true',
          },
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.readModifyWriteInstance).toHaveBeenCalled();
    expect(putBodies.length).toBeGreaterThan(0);
    expect(putBodies[0]?.devices.eth0).toMatchObject({
      nictype: 'bridged',
      hwaddr: expect.any(String),
      'ipv4.address': ROUTED_IP,
      'security.ipv4_filtering': 'true',
      'security.mac_filtering': 'true',
    });
  });

  it('decides quota-online root shrink from observed usage', () => {
    expect(decideRootShrink({
      resizeFamily: 'quota_online',
      actualRootBytes: 200n,
      desiredRootBytes: 50n,
      usedBytes: null,
      running: true,
    })).toBe('usage_unknown');
    expect(decideRootShrink({
      resizeFamily: 'quota_online',
      actualRootBytes: 200n,
      desiredRootBytes: 50n,
      usedBytes: 80n,
      running: true,
    })).toBe('usage_floor');
    expect(decideRootShrink({
      resizeFamily: 'quota_online',
      actualRootBytes: 200n,
      desiredRootBytes: 120n,
      usedBytes: 80n,
      running: true,
    })).toBe('allow');
  });

  it('never emits Incus resize/PUT when quota-online shrink is below usage', async () => {
    const { reconciler, client, putBodies } = await harness({
      status: 'Running',
      powerIntent: 'running',
      rootResizeFamily: 'quota_online',
      rootSizeBytes: 50_000_000,
      documentExtras: {
        devices: {
          root: {
            type: 'disk',
            path: '/',
            pool: ROOT_POOL,
            size: '2000000000',
          },
        },
      },
    });

    await expect(reconciler.reconcile(context(client))).rejects.toMatchObject({
      code: 'ROOT_SHRINK_BELOW_USAGE',
    });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
  });

  it('never emits Incus resize/PUT when block_backed running root shrink is requested', async () => {
    const { reconciler, client, putBodies } = await harness({
      status: 'Running',
      powerIntent: 'running',
      rootResizeFamily: 'block_backed',
      rootSizeBytes: 5_000_000_000,
      documentExtras: {
        devices: {
          root: {
            type: 'disk',
            path: '/',
            pool: ROOT_POOL,
            size: '10000000000',
          },
        },
      },
    });

    await expect(reconciler.reconcile(context(client))).rejects.toMatchObject({
      code: 'ROOT_SHRINK_REQUIRES_STOP',
    });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(client.updateInstance).not.toHaveBeenCalled();
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
  });

  it('rewrites a stale display label on a full scan without auditing it as drift', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const { reconciler, client, putBodies } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: { config: { 'user.nyabase.display.server': 'old-name' } },
      audit,
    });

    const outcome = await reconciler.reconcile(context(client, { request: { source: 'full_scan' } }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(putBodies).toHaveLength(1);
    expect(putBodies[0]!.config['user.nyabase.display.server']).toBe('lab-a');
    expect(audit.log).not.toHaveBeenCalledWith(
      expect.anything(),
      AuditAction.ContainerDriftCorrected,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('audits real drift found next to a stale display label without listing the label', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const { reconciler, client } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      documentExtras: { config: { 'user.nyabase.display.server': 'old-name', 'operator.note': 'x' } },
      audit,
    });

    await reconciler.reconcile(context(client, { request: { source: 'full_scan' } }));
    expect(audit.log).toHaveBeenCalledWith(
      null,
      AuditAction.ContainerDriftCorrected,
      CONTAINER_ID,
      'container',
      expect.objectContaining({ config: ['operator.note'], devices: [] }),
    );
  });

  it('audits Incus createInstance as IncusMutate', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const { reconciler, client, expectedName } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      missingInstance: true,
      audit,
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(client.createInstance).toHaveBeenCalledOnce();
    expect(audit.log).toHaveBeenCalledWith(
      null,
      AuditAction.IncusMutate,
      CONTAINER_ID,
      'container',
      expect.objectContaining({
        method: 'POST',
        path: '/1.0/instances',
        instanceName: expectedName,
        serverId: SERVER_ID,
        intentId: '55555555-5555-4555-8555-555555555555',
      }),
    );
  });
});

describe('container reconciler full scan', () => {
  it('enqueues when power_intent is running but the instance is stopped', async () => {
    const { reconciler, client, ensurePending } = scanHarness({
      needsAttention: false,
      lifecyclePhase: 'active',
      powerIntent: 'running',
      status: 'Stopped',
    });

    await reconciler.scan(SERVER_ID, client as never, new AbortController().signal);

    expect(ensurePending).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'container.update',
      resourceId: CONTAINER_ID,
      reuseSettled: false,
      request: { source: 'full_scan', idempotencyKey: 'physical:scan' },
    }));
  });

  it('does not enqueue a matching running instance (guest IP persist covers reboot)', async () => {
    const { reconciler, client, ensurePending } = scanHarness({
      needsAttention: false,
      lifecyclePhase: 'active',
      powerIntent: 'running',
      status: 'Running',
    });

    await reconciler.scan(SERVER_ID, client as never, new AbortController().signal);

    expect(ensurePending).not.toHaveBeenCalled();
  });

  it('keeps scanning when one container cannot be specified, then releases idle CPU sets', async () => {
    const { reconciler, client, ensurePending, cpuSets } = scanHarness({
      needsAttention: false,
      lifecyclePhase: 'active',
      powerIntent: 'running',
      status: 'Running',
      previewError: new Error('cpu_topology_unknown'),
    });

    await expect(reconciler.scan(SERVER_ID, client as never, new AbortController().signal)).resolves.toBeUndefined();

    expect(ensurePending).not.toHaveBeenCalled();
    expect(cpuSets.preview).toHaveBeenCalled();
    expect(cpuSets.releaseIdle).toHaveBeenCalledWith(SERVER_ID);
  });

  it('stops an orphan instance at once and deletes it only when its quarantine is over', async () => {
    const orphanId = '99999999-9999-4999-8999-999999999999';
    const orphanName = deriveInstanceName(orphanId);
    const orphan = {
      name: orphanName,
      config: {
        'user.nyabase.managed': 'true',
        'user.nyabase.container_id': orphanId,
        'user.nyabase.server_id': SERVER_ID,
      },
      devices: {},
      state: { status: 'Running', status_code: 101 },
    };
    const run = async (due: boolean) => {
      const { reconciler, client } = scanHarness({
        needsAttention: false,
        lifecyclePhase: 'active',
        powerIntent: 'running',
        status: 'Running',
      });
      const listed = (await client.listInstances()).metadata;
      const mocks = client as unknown as Record<string, Mock<(...args: never[]) => Promise<unknown>>>;
      mocks.listInstances!.mockResolvedValue(syncResponse([...listed, orphan]));
      mocks.getInstanceState!.mockImplementation(async (name?: string) =>
        syncResponse(name === orphanName ? orphan.state : listed[0]!.state));
      mocks.getInstanceFull!.mockImplementation(async (name?: string) => {
        if (name === orphanName) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
        return syncResponse(listed[0]);
      });
      const orphans = {
        sight: vi.fn().mockResolvedValue({
          fresh: [],
          due: due ? [{ poolName: '', name: orphanName }] : [],
        }),
        forget: vi.fn().mockResolvedValue(undefined),
      };
      Object.assign((reconciler as unknown as { store: object }).store, { orphans });
      await reconciler.scan(SERVER_ID, client as never, new AbortController().signal);
      return { client, orphans };
    };

    const quarantined = await run(false);
    expect(quarantined.orphans.sight).toHaveBeenCalledWith(SERVER_ID, 'instance', [{ poolName: '', name: orphanName }]);
    expect(quarantined.client.updateInstanceState).toHaveBeenCalledWith(
      orphanName,
      { action: 'stop', force: true },
      expect.anything(),
    );
    expect(quarantined.client.deleteInstance).not.toHaveBeenCalled();

    const overdue = await run(true);
    expect(overdue.client.deleteInstance).toHaveBeenCalledWith(orphanName, expect.anything());
    expect(overdue.orphans.forget).toHaveBeenCalledWith(SERVER_ID, 'instance', { poolName: '', name: orphanName });
  });

  it('skips needs_attention rows during scan enqueue', async () => {
    const { reconciler, client, ensurePending } = scanHarness({
      needsAttention: true,
      lifecyclePhase: 'active',
      powerIntent: 'running',
      status: 'Running',
    });

    await reconciler.scan(SERVER_ID, client as never, new AbortController().signal);

    expect(ensurePending).not.toHaveBeenCalled();
  });
});

interface AttachmentFixture {
  readonly id: string;
  readonly volumeId: string;
  readonly containerPath: string;
  readonly bindState?: 'attaching' | 'attached' | 'detaching';
  readonly shared?: boolean;
}

interface HarnessOptions {
  readonly status: 'Running' | 'Stopped';
  readonly powerIntent: 'running' | 'stopped';
  readonly rootResizeFamily?: 'quota_online' | 'block_backed';
  readonly rootSizeBytes?: number;
  readonly attachments?: readonly AttachmentFixture[];
  readonly documentExtras?: {
    readonly config?: Record<string, string>;
    readonly devices?: Record<string, Record<string, string>>;
  };
  readonly missingInstance?: boolean;
  readonly audit?: { log: ReturnType<typeof vi.fn> };
  readonly database?: unknown;
}

function attachment(
  id: string,
  volumeId: string,
  containerPath: string,
  bindState: AttachmentFixture['bindState'] = 'attached',
  shared = false,
): AttachmentFixture {
  return { id, volumeId, containerPath, bindState, shared };
}

function diskDevice(volumeId: string, path: string): Record<string, string> {
  return {
    type: 'disk',
    pool: ROOT_POOL,
    source: deriveVolumeName(volumeId),
    path,
  };
}

function containerRow(options: HarnessOptions) {
  return {
    id: CONTAINER_ID,
    server_id: SERVER_ID,
    owner_id: '33333333-3333-4333-8333-333333333333',
    name: 'dev',
    server_name: 'lab-a',
    image_id: '44444444-4444-4444-8444-444444444444',
    revision: 3,
    image_fingerprint: IMAGE_FINGERPRINT,
    root_size_bytes: String(options.rootSizeBytes ?? 10_737_418_240),
    mem_bytes: '1073741824',
    cpu_set: TEST_CPUS,
    nesting: true,
    syscall_intercept: true,
    power_intent: options.powerIntent,
    lifecycle_phase: 'active' as const,
    root_pool_name: ROOT_POOL,
    root_resize_family: options.rootResizeFamily ?? 'quota_online',
    parent_interface: PARENT,
    routed_ip: ROUTED_IP,
    network_key: '198.51.100.0/24',
    gateway: '198.51.100.1',
    dns_servers: [] as string[],
    login_user: 'root',
    ssh_public_key: null,
  };
}

function attachmentRows(attachments: readonly AttachmentFixture[]) {
  return attachments.map((item) => ({
    id: item.id,
    container_path: item.containerPath,
    read_only: false,
    volume_id: item.volumeId,
    incus_name: deriveVolumeName(item.volumeId),
    pool_name: ROOT_POOL,
    size_bytes: '10',
    shared: item.shared === true,
    bind_state: item.bindState ?? 'attached',
  }));
}

const TEST_CPUS = [0, 1];
const TEST_LIMITS = {
  processes: 4096,
  networkIngressMbit: 1000,
  networkEgressMbit: 1000,
  diskReadMBps: 500,
  diskWriteMBps: 500,
};

/** CPU sets, limits and the IAM change bus the reconciler needs beyond its store. */
function runtimeDeps(): [never, never, never, never, never] {
  const configValues: Record<string, number> = {
    'containers.processLimit': TEST_LIMITS.processes,
    'containers.networkIngressMbit': TEST_LIMITS.networkIngressMbit,
    'containers.networkEgressMbit': TEST_LIMITS.networkEgressMbit,
    'containers.diskReadMBps': TEST_LIMITS.diskReadMBps,
    'containers.diskWriteMBps': TEST_LIMITS.diskWriteMBps,
  };
  return [
    {
      resolve: vi.fn().mockResolvedValue(TEST_CPUS),
      preview: vi.fn().mockResolvedValue(TEST_CPUS),
      releaseIdle: vi.fn().mockResolvedValue(undefined),
    },
    { get: (key: string) => configValues[key] },
    { onChange: vi.fn() },
    { wake: vi.fn() },
    { certify: vi.fn().mockResolvedValue(null) },
  ] as [never, never, never, never, never];
}

function desiredFrom(options: HarnessOptions): DesiredInstanceSpec {
  return buildDesiredInstanceSpec({
    container: {
      id: CONTAINER_ID,
      name: 'dev',
      serverId: SERVER_ID,
      revision: 3,
      imageFingerprint: IMAGE_FINGERPRINT,
      cpus: TEST_CPUS,
      memBytes: 1_073_741_824,
      nesting: true,
      syscallIntercept: true,
      rootPool: ROOT_POOL,
      rootSizeBytes: options.rootSizeBytes ?? 10_737_418_240,
      routedIp: ROUTED_IP,
    },
    server: {
      id: SERVER_ID,
      name: 'lab-a',
      parentInterface: PARENT,
    },
    attachments: (options.attachments ?? []).map((item) => ({
      id: item.id,
      containerPath: item.containerPath,
      readOnly: false,
      volume: {
        id: item.volumeId,
        incusName: deriveVolumeName(item.volumeId),
        poolName: ROOT_POOL,
      },
    })),
    limits: TEST_LIMITS,
  });
}

function actualDocument(options: HarnessOptions) {
  const desired = desiredFrom(options);
  const extras = options.documentExtras ?? {};
  const config = {
    ...(desired.config ?? {}),
    ...(extras.config ?? {}),
  };
  const devices: Record<string, Record<string, string>> = {
    ...(desired.devices ?? {}),
  };
  // Start from the managed desired document, then apply extras. Attachment
  // maps in extras fully replace managed nyd-* devices when any nyd-* key is
  // present so add/remove fixtures can omit devices intentionally.
  const extrasDevices = extras.devices ?? {};
  const extrasHasAttachments = Object.keys(extrasDevices).some((name) => name.startsWith('nyd-'));
  if (extrasHasAttachments) {
    for (const name of Object.keys(devices)) {
      if (name.startsWith('nyd-')) delete devices[name];
    }
  }
  for (const [name, device] of Object.entries(extrasDevices)) {
    devices[name] = { ...device };
  }
  return {
    name: deriveInstanceName(CONTAINER_ID),
    architecture: 'x86_64',
    ephemeral: false,
    profiles: [] as string[],
    stateful: false,
    description: '',
    config,
    devices,
    state: {
      status: options.status,
      status_code: options.status === 'Running' ? 101 : 102,
      disk: {
        root: { usage: 1_000_000_000 },
      },
    },
  };
}

function syncResponse<T>(metadata: T, etag = '"etag-1"') {
  return {
    status: 200,
    envelope: {
      type: 'sync' as const,
      status: 'Success',
      status_code: 200,
      operation: '',
      error_code: 0,
      error: '',
      metadata,
    },
    metadata,
    etag,
  };
}

function volumeBindDb(rows: Array<{ id: string; bind_state: string; device_name: string }>) {
  const updated: string[] = [];
  const deleted: string[] = [];
  const makeQuery = (kind: 'select' | 'update' | 'delete') => {
    const query: Record<string, unknown> = {};
    let idFilter: string | undefined;
    for (const method of ['select', 'selectAll', 'innerJoin', 'orderBy', 'set', 'values']) {
      query[method] = vi.fn(() => query);
    }
    query.where = vi.fn((column: string, _op: string, value: unknown) => {
      if (column === 'id') idFilter = String(value);
      return query;
    });
    query.execute = vi.fn(async () => {
      if (kind === 'select') return rows;
      if (kind === 'update' && idFilter) updated.push(idFilter);
      if (kind === 'delete' && idFilter) deleted.push(idFilter);
      return [];
    });
    query.executeTakeFirst = vi.fn().mockResolvedValue(undefined);
    return query;
  };
  return {
    updated,
    deleted,
    db: {
      updateTable: vi.fn(() => makeQuery('update')),
      selectFrom: vi.fn(() => makeQuery('select')),
      deleteFrom: vi.fn(() => makeQuery('delete')),
      insertInto: vi.fn(() => makeQuery('select')),
    },
  };
}

function noopDb() {
  const chain = (): Record<string, unknown> => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'selectAll', 'where', 'set', 'values', 'innerJoin', 'leftJoin', 'orderBy']) {
      query[method] = vi.fn(() => query);
    }
    query.execute = vi.fn().mockResolvedValue([]);
    query.executeTakeFirst = vi.fn().mockResolvedValue(undefined);
    return query;
  };
  return {
    updateTable: vi.fn(() => chain()),
    selectFrom: vi.fn(() => chain()),
    deleteFrom: vi.fn(() => chain()),
    insertInto: vi.fn(() => chain()),
  };
}

async function harness(options: HarnessOptions) {
  const expectedName = deriveInstanceName(CONTAINER_ID);
  const store = {
    document: actualDocument(options),
  };
  const putBodies: Array<{
    config: Record<string, string>;
    devices: Record<string, Record<string, string>>;
  }> = [];
  let present = options.missingInstance !== true;

  const client = {
    getInstanceFull: vi.fn(async () => {
      if (!present) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
      return syncResponse(store.document);
    }),
    getInstanceState: vi.fn(async () => syncResponse(store.document.state)),
    listInstances: vi.fn(async () => syncResponse(present ? [store.document] : [])),
    createInstance: vi.fn(async () => {
      present = true;
      return syncResponse({});
    }),
    updateInstance: vi.fn(async () => syncResponse({})),
    updateInstanceState: vi.fn(async () => syncResponse({})),
    renameInstance: vi.fn(async () => syncResponse({})),
    deleteInstance: vi.fn(async () => syncResponse({})),
    execInstance: vi.fn(async () => syncResponse({ return: 0 })),
    // A guest without authorized_keys: the SSH step has nothing to manage.
    getFile: vi.fn(async () => { throw new IncusError('INCUS_NOT_FOUND', 'managed_failure'); }),
    getStorageVolume: vi.fn(async () => syncResponse({ name: 'volume' })),
    createStorageVolume: vi.fn(async () => syncResponse({})),
    getStorageVolumeState: vi.fn(async () => syncResponse({ usage: {} })),
    getOperationWait: vi.fn(),
    readModifyWriteInstance: vi.fn(async (
      _name: string,
      mutate: (document: {
        architecture: string;
        config: Record<string, string>;
        description: string;
        devices: Record<string, Record<string, string>>;
        ephemeral: boolean;
        profiles: string[];
        stateful: boolean;
      }) => unknown,
    ) => {
      const document = {
        architecture: store.document.architecture,
        config: { ...store.document.config },
        description: store.document.description,
        devices: Object.fromEntries(
          Object.entries(store.document.devices).map(([name, device]) => [name, { ...device }]),
        ),
        ephemeral: store.document.ephemeral,
        profiles: [...store.document.profiles],
        stateful: store.document.stateful,
      };
      mutate(document);
      putBodies.push({
        config: { ...document.config },
        devices: Object.fromEntries(
          Object.entries(document.devices).map(([name, device]) => [name, { ...device }]),
        ),
      });
      store.document = {
        ...store.document,
        config: document.config,
        devices: document.devices,
      };
      return syncResponse({});
    }),
  };

  const reconciler = new ContainerReconciler(new ContainerReconcileStore((options.database ?? noopDb()) as never, {} as never),
    new IncusContainerSshStateAdapter(),
    { notify: vi.fn() } as never,
    (options.audit ?? { log: vi.fn().mockResolvedValue(undefined) }) as never,
    { register: vi.fn() } as never,
    ...runtimeDeps(),
  );
  vi.spyOn(
    storeOf(reconciler) as unknown as { readContainer: () => Promise<unknown> },
    'readContainer',
  ).mockResolvedValue(containerRow(options));
  vi.spyOn(
    storeOf(reconciler) as unknown as { readAttachments: () => Promise<unknown> },
    'readAttachments',
  ).mockResolvedValue(attachmentRows(options.attachments ?? []));
  vi.spyOn(
    reconciler as unknown as { persistObservation: () => Promise<void> },
    'persistObservation',
  ).mockResolvedValue(undefined);

  return { reconciler, client, putBodies, store, expectedName };
}

function scanHarness(options: {
  readonly needsAttention: boolean;
  readonly lifecyclePhase: 'active' | 'deleting' | 'failed';
  readonly powerIntent: 'running' | 'stopped';
  readonly status: 'Running' | 'Stopped';
  readonly previewError?: Error;
}) {
  const document = actualDocument({
    status: options.status,
    powerIntent: options.powerIntent,
  });
  const rows = [{
    id: CONTAINER_ID,
    revision: 3,
    server_id: SERVER_ID,
    lifecycle_phase: options.lifecyclePhase,
    needs_attention: options.needsAttention,
    power_intent: options.powerIntent,
  }];
  const fullRow = {
    ...containerRow({
      status: options.status,
      powerIntent: options.powerIntent,
    }),
    ...rows[0],
  };
  let executeCount = 0;
  const chain = (): Record<string, unknown> => {
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'selectAll', 'where', 'set', 'values', 'innerJoin', 'leftJoin', 'orderBy']) {
      query[method] = vi.fn(() => query);
    }
    query.execute = vi.fn(async () => {
      executeCount += 1;
      return executeCount === 1 ? rows : [];
    });
    query.executeTakeFirst = vi.fn().mockResolvedValue(fullRow);
    return query;
  };
  const ensurePending = vi.fn().mockResolvedValue({ id: 'scan-intent' });
  const deps = runtimeDeps();
  const cpuSets = deps[0] as unknown as { preview: ReturnType<typeof vi.fn>; releaseIdle: ReturnType<typeof vi.fn> };
  if (options.previewError) cpuSets.preview.mockRejectedValue(options.previewError);
  const reconciler = new ContainerReconciler(new ContainerReconcileStore({
      updateTable: vi.fn(() => chain()),
      selectFrom: vi.fn(() => chain()),
      deleteFrom: vi.fn(() => chain()),
      insertInto: vi.fn(() => chain()),
    } as never, { ensurePending } as never),
    new IncusContainerSshStateAdapter(),
    { notify: vi.fn() } as never,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    { register: vi.fn() } as never,
    ...deps,
  );
  const client = {
    listInstances: vi.fn(async () => syncResponse([document])),
    getInstanceFull: vi.fn(async () => syncResponse(document)),
    getInstanceState: vi.fn(async () => syncResponse(document.state)),
    deleteInstance: vi.fn(async () => syncResponse({})),
    updateInstanceState: vi.fn(async () => syncResponse({})),
  };
  return { reconciler, client, ensurePending, cpuSets };
}

function context(client: unknown, intentOverrides: Partial<IntentRecord> = {}): ReconcileRunContext {
  const intent: IntentRecord = {
    id: '55555555-5555-4555-8555-555555555555',
    kind: IntentKind.ContainerUpdate,
    resourceType: IntentResourceType.Container,
    resourceId: CONTAINER_ID,
    serverId: SERVER_ID,
    requestedBy: null,
    request: { source: 'test' },
    targetRevision: 3,
    baseline: null,
    status: IntentStatus.Pending,
    failureCode: null,
    failure: null,
    attemptCount: 1,
    nextAttemptAt: null,
    createdAt: '2026-08-07T15:00:00.000Z',
    settledAt: null,
    ...intentOverrides,
  };
  return {
    intent,
    client: client as ReconcileRunContext['client'],
    claim: {
      resourceType: 'container',
      resourceId: CONTAINER_ID,
      serverId: SERVER_ID,
      owner: 'test-owner',
      leaseExpiresAt: new Date('2099-01-01T00:00:00.000Z').toISOString(),
    } as never,
    lease: { assert: vi.fn(), touch: vi.fn() } as never,
    signal: new AbortController().signal,
  };
}

/** Make the harness instance follow start/stop/restart like Incus would. */
function followPower(setup: Awaited<ReturnType<typeof harness>>) {
  let boots = 0;
  const actions: string[] = [];
  (setup.client.updateInstanceState as Mock<(...args: never[]) => Promise<unknown>>).mockImplementation(async (
    _name: string,
    body: { action: string },
  ) => {
    actions.push(body.action);
    const state = setup.store.document.state as Record<string, unknown>;
    if (body.action === 'stop') {
      setup.store.document.state = { ...state, status: 'Stopped', status_code: 102 } as never;
    } else {
      boots += 1;
      setup.store.document.state = {
        ...state,
        status: 'Running',
        status_code: 101,
        started_at: `2026-08-07T16:00:0${boots}.000Z`,
      } as never;
    }
    return syncResponse({});
  });
  return actions;
}

function mockRow(setup: Awaited<ReturnType<typeof harness>>, overrides: Record<string, unknown>) {
  (storeOf(setup.reconciler) as unknown as { readContainer: ReturnType<typeof vi.fn> })
    .readContainer.mockResolvedValue({
      ...containerRow({ status: 'Running', powerIntent: 'running' }),
      ...overrides,
    });
}

describe('container reconciler: changes that need a stopped instance never block power-off', () => {
  const gpuDrift = { config: { 'nvidia.runtime': 'true' } };

  it('stops first, then removes leftover GPU config, when the container should be stopped', async () => {
    const setup = await harness({ status: 'Running', powerIntent: 'stopped', documentExtras: gpuDrift });
    const actions = followPower(setup);
    const outcome = await setup.reconciler.reconcile(context(setup.client, {
      kind: IntentKind.ContainerPower,
      request: { action: 'stop', operation: 'stop' },
    }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(actions).toEqual(['stop']);
    expect(setup.putBodies).toHaveLength(1);
    expect(setup.putBodies[0]!.config['nvidia.runtime']).toBeUndefined();
  });

  it('still refuses a GPU change on a container that should keep running', async () => {
    const setup = await harness({ status: 'Running', powerIntent: 'running', documentExtras: gpuDrift });
    const actions = followPower(setup);
    const outcome = await setup.reconciler.reconcile(context(setup.client));
    expect(outcome).toMatchObject({ outcome: 'failed', failure: { code: 'GPU_MUTATION_REQUIRES_STOP' } });
    expect(actions).toEqual([]);
    expect(setup.putBodies).toHaveLength(0);
  });

  it('applies a GPU change during a restart: stop, PUT, start, proven by started_at', async () => {
    const setup = await harness({ status: 'Running', powerIntent: 'running', documentExtras: gpuDrift });
    (setup.store.document.state as Record<string, unknown>).started_at = '2026-08-07T15:00:00.000Z';
    const actions = followPower(setup);
    const outcome = await setup.reconciler.reconcile(context(setup.client, {
      kind: IntentKind.ContainerPower,
      request: { action: 'restart', operation: 'restart' },
      baseline: { startedAt: '2026-08-07T15:00:00.000Z' },
    }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(actions).toEqual(['stop', 'start']);
    expect(setup.putBodies).toHaveLength(1);
  });

  it('stops before an accepted block-backed root shrink instead of failing the stop', async () => {
    const setup = await harness({
      status: 'Running',
      powerIntent: 'stopped',
      rootResizeFamily: 'block_backed',
      rootSizeBytes: 5_000_000_000,
      documentExtras: {
        devices: { root: { type: 'disk', path: '/', pool: ROOT_POOL, size: '10000000000' } },
      },
    });
    const actions = followPower(setup);
    const outcome = await setup.reconciler.reconcile(context(setup.client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(actions).toEqual(['stop']);
    expect(setup.putBodies[0]!.devices.root!.size).toBe('5000000000');
  });

  it('stops the instance even while an attached volume is not ready on the server', async () => {
    // A local volume whose create failed: it never appears in the Incus catalog.
    const setup = await harness({
      status: 'Running',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching')],
    });
    const actions = followPower(setup);
    setup.client.getStorageVolume.mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    const stop = context(setup.client, {
      kind: IntentKind.ContainerPower,
      request: { action: 'stop', operation: 'stop' },
    });

    await expect(setup.reconciler.reconcile(stop)).rejects.toMatchObject({
      code: 'VOLUME_PLACEMENT_PENDING',
      disposition: 'retry',
    });
    expect(actions).toEqual(['stop']);
    expect(setup.client.readModifyWriteInstance).not.toHaveBeenCalled();

    // Retried, the stopped instance is left alone.
    await expect(setup.reconciler.reconcile(stop)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });
    expect(actions).toEqual(['stop']);
  });

  it('stops the instance even while a shared volume has no placement on the server', async () => {
    const setup = await harness({ status: 'Running', powerIntent: 'stopped' });
    const actions = followPower(setup);
    (storeOf(setup.reconciler) as unknown as { readAttachments: ReturnType<typeof vi.fn> })
      .readAttachments.mockRejectedValue(new IncusError('VOLUME_PLACEMENT_PENDING', 'retry', {
        volumeId: VOLUME_ADD,
        serverId: SERVER_ID,
      }));

    await expect(setup.reconciler.reconcile(context(setup.client))).rejects.toMatchObject({
      code: 'VOLUME_PLACEMENT_PENDING',
    });
    expect(actions).toEqual(['stop']);
  });

  it('fails visibly instead of retrying forever once a volume stays not ready', async () => {
    const setup = await harness({
      status: 'Stopped',
      powerIntent: 'running',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching')],
    });
    const actions = followPower(setup);
    setup.client.getStorageVolume.mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));

    // Only not-ready passes count: an intent whose attempts piled up while the
    // agent was away (unreachable retries) still gets every one of them.
    const pass = context(setup.client, { attemptCount: 40 });
    for (let attempt = 0; attempt < VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS; attempt += 1) {
      await expect(setup.reconciler.reconcile(pass)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });
    }
    const outcome = await setup.reconciler.reconcile(pass);

    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: {
        code: FailureCode.VolumePlacementFailed,
        details: { volumeId: VOLUME_ADD, serverId: SERVER_ID },
      },
    });
    // It never starts without the volume, and never writes the instance.
    expect(actions).toEqual([]);
    expect(setup.client.readModifyWriteInstance).not.toHaveBeenCalled();
  });

  it('counts consecutive not-ready passes per intent and starts over once the volume was ready', async () => {
    const setup = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      attachments: [attachment(ATTACH_ADD, VOLUME_ADD, '/data/add', 'attaching')],
    });
    setup.client.getStorageVolume.mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    const first = context(setup.client);
    for (let attempt = 0; attempt < VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS; attempt += 1) {
      await expect(setup.reconciler.reconcile(first)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });
    }
    // Another intent of the same container has its own count.
    const other = context(setup.client, { id: '66666666-6666-4666-8666-666666666666' });
    await expect(setup.reconciler.reconcile(other)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });
    // One ready pass (failing later, reading the instance) resets the first intent's count.
    setup.client.getStorageVolume.mockResolvedValueOnce(syncResponse({ name: 'volume' }));
    setup.client.getInstanceState.mockRejectedValueOnce(new IncusError('INCUS_TIMEOUT', 'retry'));
    await expect(setup.reconciler.reconcile(first)).rejects.toMatchObject({ code: 'INCUS_TIMEOUT' });
    for (let attempt = 0; attempt < VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS; attempt += 1) {
      await expect(setup.reconciler.reconcile(first)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });
    }
    await expect(setup.reconciler.reconcile(first)).resolves.toMatchObject({
      outcome: 'failed',
      failure: { code: FailureCode.VolumePlacementFailed },
    });
  });
});

describe('container reconciler: detaching never waits for the other attachments', () => {
  async function detachingSetup(options: { readonly status: 'Running' | 'Stopped'; readonly missingInstance?: boolean }) {
    const removeName = deriveAttachmentDeviceName(ATTACH_REMOVE);
    const setup = await harness({
      status: options.status,
      powerIntent: 'running',
      missingInstance: options.missingInstance,
      // The attachment kept on the container is local and was never created on this server.
      attachments: [attachment(ATTACH_KEEP, VOLUME_KEEP, '/data/keep')],
      documentExtras: {
        devices: {
          [deriveAttachmentDeviceName(ATTACH_KEEP)]: diskDevice(VOLUME_KEEP, '/data/keep'),
          [removeName]: diskDevice(VOLUME_REMOVE, '/data/remove'),
        },
      },
    });
    const store = storeOf(setup.reconciler) as unknown as {
      readDetachingDevices: () => Promise<string[]>;
      settleVolumeBinds: () => Promise<void>;
    };
    vi.spyOn(store, 'readDetachingDevices').mockResolvedValue([removeName]);
    const settle = vi.spyOn(store, 'settleVolumeBinds').mockResolvedValue(undefined);
    setup.client.getStorageVolume.mockRejectedValue(new IncusError('INCUS_NOT_FOUND', 'managed_failure'));
    return { ...setup, removeName, settle };
  }

  it('unplugs a detaching volume from the running instance while another volume is not ready', async () => {
    const setup = await detachingSetup({ status: 'Running' });
    const actions = followPower(setup);

    const detach = context(setup.client, {
      request: { operation: 'detach_volume', attachmentId: ATTACH_REMOVE },
    });
    await expect(setup.reconciler.reconcile(detach)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });

    // Only the detaching device left; the instance, its other devices and its power stay.
    expect(setup.putBodies).toHaveLength(1);
    expect(setup.putBodies[0]!.devices[setup.removeName]).toBeUndefined();
    expect(setup.putBodies[0]!.devices[deriveAttachmentDeviceName(ATTACH_KEEP)]).toBeDefined();
    expect(setup.putBodies[0]!.devices.root).toBeDefined();
    expect(actions).toEqual([]);
    // The detach is settled at once: its row goes although the pass fails.
    const settled = setup.settle.mock.calls[0] as unknown as [string, { devices: Record<string, unknown> }, boolean];
    expect(settled[0]).toBe(CONTAINER_ID);
    expect(settled[1].devices[setup.removeName]).toBeUndefined();
    expect(settled[2]).toBe(true);

    // The pass still ends (and at last fails) on the volume that is not ready,
    // without touching the instance again.
    for (let attempt = 0; attempt < VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS - 1; attempt += 1) {
      await expect(setup.reconciler.reconcile(detach)).rejects.toMatchObject({ code: 'VOLUME_PLACEMENT_PENDING' });
    }
    await expect(setup.reconciler.reconcile(detach)).resolves.toMatchObject({
      outcome: 'failed',
      failure: { code: FailureCode.VolumePlacementFailed },
    });
    expect(setup.putBodies).toHaveLength(1);
  });

  it('settles a detach at once when the container has no instance on the server', async () => {
    const setup = await detachingSetup({ status: 'Stopped', missingInstance: true });

    await expect(setup.reconciler.reconcile(context(setup.client))).rejects.toMatchObject({
      code: 'VOLUME_PLACEMENT_PENDING',
    });

    expect(setup.client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(setup.settle).toHaveBeenCalledWith(CONTAINER_ID, { devices: {} }, true);
  });

  it('falls back to the full managed document when the agent refuses the unplug over host drift', async () => {
    const removeName = deriveAttachmentDeviceName(ATTACH_REMOVE);
    const binds = volumeBindDb([{ id: ATTACH_REMOVE, bind_state: 'detaching', device_name: removeName }]);
    const setup = await harness({
      status: 'Running',
      powerIntent: 'running',
      database: binds.db,
      attachments: [attachment(ATTACH_REMOVE, VOLUME_REMOVE, '/data/remove', 'detaching')],
      documentExtras: {
        // Host-side drift the agent policy refuses to write back.
        config: { 'raw.lxc': 'lxc.apparmor.profile=unconfined' },
        devices: { [removeName]: diskDevice(VOLUME_REMOVE, '/data/remove') },
      },
    });
    const write = setup.client.readModifyWriteInstance.getMockImplementation()!;
    const refused: unknown[] = [];
    setup.client.readModifyWriteInstance.mockImplementation(async (name, mutate, ...rest) => {
      const probe = structuredClone({ ...setup.store.document, state: undefined });
      mutate(probe as never);
      if (probe.config['raw.lxc'] !== undefined) {
        const error = new IncusError('AGENT_POLICY_DENIED', 'managed_failure', { message: 'raw.lxc' });
        refused.push(error);
        throw error;
      }
      return write(name, mutate, ...rest);
    });
    const actions = followPower(setup);

    const outcome = await setup.reconciler.reconcile(context(setup.client, {
      request: { operation: 'detach_volume', attachmentId: ATTACH_REMOVE },
    }));

    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(refused).toHaveLength(1);
    // One write: the whole managed document, drift and detaching device gone.
    expect(setup.putBodies).toHaveLength(1);
    expect(setup.putBodies[0]!.config['raw.lxc']).toBeUndefined();
    expect(setup.putBodies[0]!.devices[removeName]).toBeUndefined();
    expect(setup.putBodies[0]!.devices.root).toBeDefined();
    expect(actions).toEqual([]);
    expect(binds.deleted).toContain(ATTACH_REMOVE);
  });

  it('still fails the pass when the unplug fails for another reason', async () => {
    const setup = await detachingSetup({ status: 'Running' });
    setup.client.readModifyWriteInstance.mockRejectedValue(
      new IncusError('OPERATION_FAILED', 'managed_failure'),
    );

    await expect(setup.reconciler.reconcile(context(setup.client))).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
    });
    expect(setup.client.readModifyWriteInstance).toHaveBeenCalledTimes(1);
    expect(setup.settle).not.toHaveBeenCalled();
  });
});

describe('container reconciler: superseded intents', () => {
  it('carries a superseded restart forward onto the current revision', async () => {
    const setup = await harness({ status: 'Running', powerIntent: 'running' });
    (setup.store.document.state as Record<string, unknown>).started_at = '2026-08-07T15:00:00.000Z';
    const actions = followPower(setup);
    const outcome = await setup.reconciler.reconcile(context(setup.client, {
      kind: IntentKind.ContainerPower,
      targetRevision: 2,
      request: { action: 'restart', operation: 'restart' },
      baseline: { startedAt: '2026-08-07T15:00:00.000Z' },
    }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(actions).toEqual(['restart']);
  });

  it('settles a restart replaced by a later stop as failed, never as succeeded', async () => {
    const setup = await harness({ status: 'Stopped', powerIntent: 'stopped' });
    const outcome = await setup.reconciler.reconcile(context(setup.client, {
      kind: IntentKind.ContainerPower,
      targetRevision: 2,
      request: { action: 'restart', operation: 'restart' },
      baseline: { startedAt: null },
    }));
    expect(outcome).toMatchObject({ outcome: 'failed', stale: true, failure: { code: 'RESTART_SUPERSEDED' } });
    expect(setup.client.updateInstanceState).not.toHaveBeenCalled();
  });

  it('deletes a deleting container even from an intent older than its revision', async () => {
    const setup = await harness({ status: 'Stopped', powerIntent: 'stopped' });
    mockRow(setup, { lifecycle_phase: 'deleting', power_intent: 'stopped' });
    const release = vi.spyOn(
      storeOf(setup.reconciler) as unknown as { releaseContainerState: () => Promise<void> },
      'releaseContainerState',
    ).mockResolvedValue(undefined);
    let present = true;
    setup.client.deleteInstance.mockImplementation(async () => {
      present = false;
      return syncResponse({});
    });
    setup.client.getInstanceFull.mockImplementation(async () => {
      if (!present) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure');
      return syncResponse(setup.store.document);
    });
    const outcome = await setup.reconciler.reconcile(context(setup.client, { targetRevision: 1 }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(setup.client.deleteInstance).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('treats a delete whose row is already gone as done (lease lost after the delete)', async () => {
    const setup = await harness({ status: 'Stopped', powerIntent: 'stopped' });
    (storeOf(setup.reconciler) as unknown as { readContainer: ReturnType<typeof vi.fn> })
      .readContainer.mockResolvedValue(undefined);
    const outcome = await setup.reconciler.reconcile(context(setup.client, { kind: IntentKind.ContainerDelete }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedRevision: 3, stale: true });
    expect(setup.client.getInstanceFull).not.toHaveBeenCalled();
  });
});

describe('container reconciler: bounded SSH readiness wait', () => {
  const key = 'ssh-ed25519 AAAA fixture';

  async function sshHarness() {
    const setup = await harness({ status: 'Running', powerIntent: 'running' });
    mockRow(setup, { ssh_public_key: key });
    const sshState = (setup.reconciler as unknown as { sshState: IncusContainerSshStateAdapter }).sshState;
    vi.spyOn(sshState, 'readAuthorizedKeys').mockResolvedValue({
      body: Buffer.from(withManagedKeys('', key)),
      uid: 0,
      gid: 0,
      mode: 0o600,
      type: 'file',
    } as never);
    vi.spyOn(sshState, 'probeSshd').mockResolvedValue('unknown');
    return setup;
  }

  it('lets only a fresh create wait for sshd', async () => {
    const setup = await sshHarness();
    const outcome = await setup.reconciler.reconcile(context(setup.client, {
      kind: IntentKind.ContainerCreate,
      createdAt: new Date().toISOString(),
    }));
    expect(outcome).toMatchObject({ outcome: 'retry', failure: { code: 'SSH_DAEMON_PENDING' } });
  });

  it('settles a create after the wait, and any other intent at once, with sshd still not listening', async () => {
    const setup = await sshHarness();
    const persist = (setup.reconciler as unknown as { persistObservation: ReturnType<typeof vi.fn> })
      .persistObservation;
    const old = await setup.reconciler.reconcile(context(setup.client, {
      kind: IntentKind.ContainerCreate,
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }));
    expect(old).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    const update = await setup.reconciler.reconcile(context(setup.client, {
      createdAt: new Date().toISOString(),
    }));
    expect(update).toEqual({ outcome: 'succeeded', observedRevision: 3 });
    expect(persist).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      false,
      { status: 'unknown', lastError: 'sshd_not_listening' },
      expect.anything(),
    );
  });
});

describe('ContainerReconciler resource status', () => {
  function statusReconciler(sets: Record<string, unknown>[]) {
    return new ContainerReconciler(new ContainerReconcileStore({
        updateTable: vi.fn(() => ({
          set: vi.fn((values: Record<string, unknown>) => {
            sets.push(values);
            return { where: vi.fn(() => ({ execute: vi.fn().mockResolvedValue(undefined) })) };
          }),
        })),
      } as never, {} as never),
      new IncusContainerSshStateAdapter(),
      { notify: vi.fn() } as never,
      { log: vi.fn() } as never,
      { register: vi.fn() } as never,
    ...runtimeDeps(),
    );
  }

  it('does not force lifecycle_phase=failed when parking a container for attention', async () => {
    const sets: Record<string, unknown>[] = [];
    await statusReconciler(sets).markFailure(CONTAINER_ID, {
      code: 'RESOURCE_NEEDS_ATTENTION',
      message: 'Instance remained busy for five attempts within five minutes',
      details: {},
    }, true);

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ needs_attention: true, failure_code: 'RESOURCE_NEEDS_ATTENTION' });
    expect(sets[0]).not.toHaveProperty('lifecycle_phase');
  });

  it('records a non-parking failure without touching needs_attention (a park survives it)', async () => {
    const sets: Record<string, unknown>[] = [];
    await statusReconciler(sets).markFailure(CONTAINER_ID, { code: 'X', message: 'm' }, false);
    expect(sets[0]).toMatchObject({ failure_code: 'X' });
    expect(sets[0]).not.toHaveProperty('needs_attention');
  });
});

describe('ContainerReconciler settlement', () => {
  it('settles a restart by id so a later desired-state success cannot cover it', async () => {
    const settleOne = vi.fn().mockResolvedValue(true);
    const settleForObservedRevision = vi.fn().mockResolvedValue({});
    const reconciler = new ContainerReconciler(new ContainerReconcileStore({} as never, { settleOne, settleForObservedRevision } as never),
      new IncusContainerSshStateAdapter(),
      { notify: vi.fn() } as never,
      { log: vi.fn() } as never,
      { register: vi.fn() } as never,
    ...runtimeDeps(),
    );
    const restart = {
      id: '55555555-5555-4555-8555-555555555555',
      kind: IntentKind.ContainerPower,
      resourceType: IntentResourceType.Container,
      resourceId: CONTAINER_ID,
      serverId: SERVER_ID,
      request: { action: 'restart' },
    } as unknown as IntentRecord;
    await reconciler.settle(restart, 4, { outcome: 'succeeded', placementServerId: SERVER_ID });
    expect(settleOne).toHaveBeenCalledWith(restart.id, expect.objectContaining({ outcome: 'succeeded' }));
    const options = settleForObservedRevision.mock.calls[0]![5] as {
      keep: (candidate: { kind: string; request: Record<string, unknown> | null }) => boolean;
    };
    expect(options.keep({ kind: IntentKind.ContainerPower, request: { action: 'restart' } })).toBe(true);
  });
});

describe('root quota polling', () => {
  it('backs off from 5 s to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 40].map(rootQuotaRetryDelay))
      .toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
});
