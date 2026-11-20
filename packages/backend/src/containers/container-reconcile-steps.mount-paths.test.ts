import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import { checkPendingMountPaths } from './container-reconcile-steps.js';
import type { PendingMount } from './container-reconcile.store.js';

const containerId = '11111111-1111-4111-8111-111111111111';
const notFound = () => new IncusError('INCUS_NOT_FOUND', 'managed_failure');

function directory(entries: string[]) {
  return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ type: 'sync', metadata: entries })), type: 'directory' };
}

function harness(pending: PendingMount[], files: Record<string, unknown>, devices: Record<string, unknown> = {}) {
  const setPendingMountState = vi.fn(async () => undefined);
  const deps = {
    store: { readPendingMounts: vi.fn(async () => pending), setPendingMountState },
    logger: { warn: vi.fn() },
  };
  const client = {
    getInstanceFull: vi.fn(async () => ({ metadata: { devices } })),
    getFile: vi.fn(async (_name: string, path: string) => {
      const file = files[path];
      if (file === undefined) throw notFound();
      if (file instanceof Error) throw file;
      return file;
    }),
  };
  return { deps, client, setPendingMountState };
}

const mount = (path: string, state: PendingMount['bind_state'] = 'attaching'): PendingMount => ({
  id: `a-${path}`,
  device_name: `nyd-${path.replaceAll('/', '')}`,
  container_path: path,
  bind_state: state,
});

describe('checkPendingMountPaths', () => {
  it('mounts over a missing or empty path, and parks one that holds files', async () => {
    const { deps, client, setPendingMountState } = harness(
      [mount('/data1'), mount('/data2'), mount('/data3'), mount('/data4')],
      { '/data2': directory([]), '/data3': directory(['old-results']), '/data4': { ...directory([]), type: 'file' } },
    );
    await checkPendingMountPaths(deps, client as never, containerId);
    expect(setPendingMountState.mock.calls).toEqual([
      ['a-/data3', 'attaching', 'blocked'],
      ['a-/data4', 'attaching', 'blocked'],
    ]);
  });

  it('mounts a parked attachment once its path is emptied', async () => {
    const { deps, client, setPendingMountState } = harness([mount('/data1', 'blocked')], { '/data1': directory([]) });
    await checkPendingMountPaths(deps, client as never, containerId);
    expect(setPendingMountState).toHaveBeenCalledWith('a-/data1', 'blocked', 'attaching');
  });

  it('does not look at a path the instance already mounts (it shows the volume itself)', async () => {
    const pending = mount('/data1');
    const { deps, client, setPendingMountState } = harness(
      [pending],
      { '/data1': directory(['volume-data']) },
      { [pending.device_name]: { type: 'disk' } },
    );
    await checkPendingMountPaths(deps, client as never, containerId);
    expect(client.getFile).not.toHaveBeenCalled();
    expect(setPendingMountState).not.toHaveBeenCalled();
  });

  it('checks nothing for a container being created, and mounts when a lookup fails otherwise', async () => {
    const creating = harness([mount('/data1')], {});
    creating.client.getInstanceFull.mockRejectedValueOnce(notFound());
    await checkPendingMountPaths(creating.deps, creating.client as never, containerId);
    expect(creating.client.getFile).not.toHaveBeenCalled();

    const failing = harness([mount('/data1', 'blocked')], { '/data1': new Error('agent timeout') });
    await checkPendingMountPaths(failing.deps, failing.client as never, containerId);
    expect(failing.setPendingMountState).toHaveBeenCalledWith('a-/data1', 'blocked', 'attaching');
    expect(failing.deps.logger.warn).toHaveBeenCalled();
  });

  it('does nothing without pending mounts', async () => {
    const { deps, client } = harness([], {});
    await checkPendingMountPaths(deps, client as never, containerId);
    expect(client.getInstanceFull).not.toHaveBeenCalled();
  });
});
