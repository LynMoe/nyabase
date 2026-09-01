import { describe, expect, it, vi } from 'vitest';
import { AuditAction, IntentKind, IntentResourceType, IntentStatus } from '@nyabase/common';
import {
  buildDesiredInstanceSpec,
  deriveAttachmentDeviceName,
  deriveInstanceName,
  deriveVolumeName,
  IncusError,
  type DesiredInstanceSpec,
} from '../incus/index.js';
import {
  ContainerReconciler,
  managedContainerIdentity,
  observedDiskUsageBytes,
  powerTransition,
  restartTransition,
  sshFileMetadataMatches,
  sshFileNeedsReconcile,
  sshObservation,
} from './container-reconciler.service.js';
import type { IntentRecord } from './intent.repository.js';
import type { ReconcileRunContext } from './reconcile-worker.service.js';

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
          'operator.note': 'preserve-me',
        },
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(client.updateInstance).not.toHaveBeenCalled();
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(client.updateInstanceState).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
    expect(client.getInstanceFull).toHaveBeenCalledWith(expectedName);
  });

  it('PUT path preserves volatile.* and operator config while preserving unmanaged devices', async () => {
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
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
    expect(client.readModifyWriteInstance).toHaveBeenCalledTimes(1);
    expect(putBodies).toHaveLength(1);
    const put = putBodies[0]!;
    expect(put.config['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(put.config['operator.note']).toBe('keep-operator');
    expect(put.config['image.os']).toBe('ubuntu');
    expect(put.config['limits.cpu']).toBe('2');
    expect(put.config['limits.cpu.allowance']).toBeUndefined();
    expect(put.config['security.privileged']).toBe('false');
    expect(put.devices.operatorDisk).toEqual({
      type: 'disk',
      source: 'operator-volume',
      path: '/operator',
    });
    expect(store.document.config?.['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(store.document.devices?.operatorDisk).toEqual({
      type: 'disk',
      source: 'operator-volume',
      path: '/operator',
    });
  });

  it('fails GPU / nvidia.runtime changes while running without any Incus write', async () => {
    const { reconciler, client, putBodies } = await harness({
      status: 'Running',
      powerIntent: 'running',
      nvidiaRuntime: true,
      gpuPciAddresses: ['0000:01:00.0'],
      documentExtras: {
        config: {
          'nvidia.runtime': 'false',
        },
        devices: {},
      },
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toMatchObject({
      outcome: 'failed',
      failure: { code: 'GPU_CHANGE_REQUIRES_STOP' },
    });
    expect(client.readModifyWriteInstance).not.toHaveBeenCalled();
    expect(client.updateInstance).not.toHaveBeenCalled();
    expect(client.createInstance).not.toHaveBeenCalled();
    expect(putBodies).toHaveLength(0);
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
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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
    let generation = 3;
    vi.spyOn(
      reconciler as unknown as { readContainer: () => Promise<unknown> },
      'readContainer',
    ).mockImplementation(async () => containerRow({
      status: 'Running',
      powerIntent: 'running',
    }));
    vi.spyOn(
      reconciler as unknown as { rereadDesired: () => Promise<unknown> },
      'rereadDesired',
    ).mockImplementation(async () => {
      const desired = rows
        .filter((item) => item.bindState !== 'detaching')
        .map((item) => attachmentRows([item])[0]);
      return { stale: generation > 3, desired };
    });
    client.getStorageVolume.mockRejectedValueOnce(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
    );
    client.createStorageVolume.mockImplementation(async () => {
      rows[0] = { ...rows[0]!, bindState: 'detaching' };
      generation = 4;
      return syncResponse({});
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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
    const outcome = await reconciler.reconcile(context(client, { targetGeneration: 2 }));
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 2 });
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
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
    expect(putBodies[0]!.devices[addName]).toMatchObject({
      type: 'disk',
      path: '/data/add',
      source: deriveVolumeName(VOLUME_ADD),
    });
    expect(putBodies[0]!.devices[removeName]).toBeUndefined();
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
    expect(first).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
    expect(second).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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

  it('audits Incus createInstance as IncusMutate', async () => {
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const { reconciler, client, expectedName } = await harness({
      status: 'Stopped',
      powerIntent: 'stopped',
      missingInstance: true,
      audit,
    });

    const outcome = await reconciler.reconcile(context(client));
    expect(outcome).toEqual({ outcome: 'succeeded', observedGeneration: 3 });
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
  readonly nvidiaRuntime?: boolean;
  readonly gpuPciAddresses?: string[];
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
    image_id: '44444444-4444-4444-8444-444444444444',
    generation: 3,
    image_fingerprint: IMAGE_FINGERPRINT,
    root_size_bytes: String(options.rootSizeBytes ?? 10_737_418_240),
    cpu_millis: 2000,
    mem_bytes: '1073741824',
    nvidia_runtime: options.nvidiaRuntime ?? false,
    gpu_pci_addresses: options.gpuPciAddresses ?? [],
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

function desiredFrom(options: HarnessOptions): DesiredInstanceSpec {
  return buildDesiredInstanceSpec({
    container: {
      id: CONTAINER_ID,
      serverId: SERVER_ID,
      generation: 3,
      imageFingerprint: IMAGE_FINGERPRINT,
      cpuMillis: 2000,
      memBytes: 1_073_741_824,
      nvidiaRuntime: options.nvidiaRuntime ?? false,
      nesting: true,
      syscallIntercept: true,
      gpuPciAddresses: options.gpuPciAddresses ?? [],
      rootPool: ROOT_POOL,
      rootSizeBytes: options.rootSizeBytes ?? 10_737_418_240,
      routedIp: ROUTED_IP,
    },
    server: {
      id: SERVER_ID,
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
  // GPU fixtures often need "no gpu devices" while desired still has them.
  if (Object.prototype.hasOwnProperty.call(extrasDevices, 'gpu0') === false
    && extras.config
    && Object.prototype.hasOwnProperty.call(extras.config, 'nvidia.runtime')
    && extras.config['nvidia.runtime'] === 'false') {
    for (const name of Object.keys(devices)) {
      if (name.startsWith('gpu')) delete devices[name];
    }
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

  const reconciler = new ContainerReconciler(
    (options.database ?? noopDb()) as never,
    undefined,
    undefined,
    undefined,
    options.audit as never,
  );
  vi.spyOn(
    reconciler as unknown as { readContainer: () => Promise<unknown> },
    'readContainer',
  ).mockResolvedValue(containerRow(options));
  vi.spyOn(
    reconciler as unknown as { readAttachments: () => Promise<unknown> },
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
}) {
  const document = actualDocument({
    status: options.status,
    powerIntent: options.powerIntent,
  });
  const rows = [{
    id: CONTAINER_ID,
    generation: 3,
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
  const reconciler = new ContainerReconciler(
    {
      updateTable: vi.fn(() => chain()),
      selectFrom: vi.fn(() => chain()),
      deleteFrom: vi.fn(() => chain()),
      insertInto: vi.fn(() => chain()),
    } as never,
    { ensurePending } as never,
  );
  const client = {
    listInstances: vi.fn(async () => syncResponse([document])),
    getInstanceFull: vi.fn(async () => syncResponse(document)),
    getInstanceState: vi.fn(async () => syncResponse(document.state)),
    deleteInstance: vi.fn(async () => syncResponse({})),
    updateInstanceState: vi.fn(async () => syncResponse({})),
  };
  return { reconciler, client, ensurePending };
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
    targetGeneration: 3,
    baseline: null,
    blockedByIntentId: null,
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
