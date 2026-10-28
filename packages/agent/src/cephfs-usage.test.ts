import { afterEach, describe, expect, it, vi } from 'vitest';
import { CEPHFS_USAGE_BUDGET_MS, CephfsUsage, type CephfsUsageDeps } from './cephfs-usage.js';

const VOLUME = `nyv-${'a'.repeat(32)}`;
const STATE = `/1.0/storage-pools/meowfs/volumes/custom/${VOLUME}/state`;
const LIVE = new AbortController().signal;

function answer(usage: Record<string, unknown> = { used: 2147483648, total: 2147483648 }, status = 200) {
  return {
    status,
    headers: { 'content-type': 'application/json', 'content-length': '99' },
    body: Buffer.from(JSON.stringify({ type: 'sync', status: 'Success', metadata: { usage } })),
  };
}

function harness(driver = 'cephfs', readRbytes: CephfsUsageDeps['readRbytes'] = vi.fn(async () => 1234)) {
  const request = vi.fn(async () => ({
    status: 200,
    headers: {},
    body: Buffer.from(JSON.stringify({ metadata: { name: 'meowfs', driver } })),
  }));
  const log = vi.fn();
  const usage = new CephfsUsage({
    incus: { request } as unknown as CephfsUsageDeps['incus'],
    incusDir: '/var/lib/incus',
    readRbytes,
    log,
  });
  return { usage, request, readRbytes, log };
}

const usageOf = (response: { body: Buffer }) =>
  (JSON.parse(response.body.toString('utf8')) as { metadata: { usage: Record<string, unknown> } }).metadata.usage;

describe('CephFS volume usage', () => {
  afterEach(() => vi.useRealTimers());

  it('replaces the quota echo with ceph.dir.rbytes of the volume directory and marks it', async () => {
    const h = harness();
    const result = await h.usage.apply('GET', STATE, answer(), LIVE);
    expect(h.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/1.0/storage-pools/meowfs' }));
    expect(h.readRbytes).toHaveBeenCalledWith(`/var/lib/incus/storage-pools/meowfs/custom/default_${VOLUME}`, expect.any(AbortSignal));
    expect(usageOf(result)).toEqual({ used: 1234, total: 2147483648, nyabase_used_source: 'ceph.dir.rbytes' });
    expect(result.headers).not.toHaveProperty('content-length');
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('asks Incus for a pool driver once', async () => {
    const h = harness();
    await h.usage.apply('GET', STATE, answer(), LIVE);
    await h.usage.apply('GET', STATE, answer(), LIVE);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.readRbytes).toHaveBeenCalledTimes(2);
  });

  it('accepts the default project and leaves others alone', async () => {
    const h = harness();
    expect(usageOf(await h.usage.apply('GET', `${STATE}?project=default`, answer(), LIVE))).toHaveProperty('nyabase_used_source');
    const other = answer();
    expect(await h.usage.apply('GET', `${STATE}?project=other`, other, LIVE)).toBe(other);
  });

  it('passes through everything that is not a platform volume state GET on a cephfs pool', async () => {
    const h = harness();
    for (const [method, path] of [
      ['PUT', STATE],
      ['GET', `/1.0/storage-pools/meowfs/volumes/custom/${VOLUME}`],
      ['GET', '/1.0/storage-pools/meowfs/volumes/custom/foreign/state'],
      ['GET', `/1.0/storage-pools/meowfs/volumes/container/${VOLUME}/state`],
      ['GET', `/1.0/storage-pools/../volumes/custom/${VOLUME}/state`],
    ] as const) {
      const original = answer();
      expect(await h.usage.apply(method, path, original, LIVE)).toBe(original);
    }
    const failed = answer({}, 404);
    expect(await h.usage.apply('GET', STATE, failed, LIVE)).toBe(failed);
    expect(h.request).not.toHaveBeenCalled();
    const zfs = harness('zfs');
    const original = answer({ used: 10, total: 20 });
    expect(await zfs.usage.apply('GET', STATE, original, LIVE)).toBe(original);
    expect(zfs.readRbytes).not.toHaveBeenCalled();
  });

  it('keeps the unmarked answer when rbytes cannot be read (the Backend then treats it as unknown)', async () => {
    const h = harness('cephfs', vi.fn(async () => { throw new Error('getfattr: Permission denied'); }));
    const original = answer();
    expect(await h.usage.apply('GET', STATE, original, LIVE)).toBe(original);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
  });

  it('gives up after the budget even when getfattr never returns (a hung mount)', async () => {
    vi.useFakeTimers();
    const h = harness('cephfs', vi.fn(() => new Promise<number>(() => undefined)));
    const original = answer();
    const pending = h.usage.apply('GET', STATE, original, LIVE);
    await vi.advanceTimersByTimeAsync(CEPHFS_USAGE_BUDGET_MS + 10);
    expect(await pending).toBe(original);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
  });

  it('stops when the Backend cancels the request', async () => {
    const h = harness('cephfs', vi.fn(() => new Promise<number>(() => undefined)));
    const controller = new AbortController();
    const original = answer();
    const pending = h.usage.apply('GET', STATE, original, controller.signal);
    controller.abort(new Error('cancelled by the Backend'));
    expect(await pending).toBe(original);
  });
});
