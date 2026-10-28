import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { CEPHFS_USAGE_SOURCE_KEY, CEPHFS_USAGE_SOURCE_RBYTES } from '@nyabase/common';
import type { LocalIncus, LocalIncusResponse } from './incus-local.js';

/** `GET` of a platform volume's state; only the default project holds them. */
const STATE_PATH = /^\/1\.0\/storage-pools\/([A-Za-z0-9][A-Za-z0-9._-]*)\/volumes\/custom\/(nyv-[0-9a-f]{32})\/state$/;

/** The whole extra work (pool driver, getfattr) gets this long; the Backend waits 5 s for a usage answer. */
export const CEPHFS_USAGE_BUDGET_MS = 3_000;
/** A pool's driver never changes under one name; re-read it now and then in case the pool was recreated. */
const DRIVER_CACHE_MS = 5 * 60_000;

export type ReadRbytes = (path: string, signal: AbortSignal) => Promise<number>;

/**
 * `ceph.dir.rbytes` of a directory: the bytes below it as the MDS accounts
 * them, the figure CephFS quotas are enforced against (propagated lazily, so
 * data another client has not flushed yet can be missing for a moment).
 * Needs CAP_DAC_READ_SEARCH: Incus keeps `custom/` at 0700 root.
 */
export const readCephRbytes: ReadRbytes = (path, signal) => new Promise((resolve, reject) => {
  execFile(
    'getfattr',
    ['--only-values', '--absolute-names', '-n', CEPHFS_USAGE_SOURCE_RBYTES, path],
    { signal },
    (error, stdout) => {
      if (error) return reject(error);
      const value = stdout.trim();
      if (!/^\d+$/.test(value)) return reject(new Error(`unexpected ${CEPHFS_USAGE_SOURCE_RBYTES} value ${JSON.stringify(value)}`));
      resolve(Number(value));
    },
  );
});

export interface CephfsUsageDeps {
  readonly incus: Pick<LocalIncus, 'request'>;
  /** Incus' state directory; volumes live under `storage-pools/<pool>/custom/`. */
  readonly incusDir: string;
  readonly readRbytes: ReadRbytes;
  readonly log: (message: string) => void;
}

/**
 * Incus' CephFS driver reports a volume's quota as its usage. For a platform
 * volume on a cephfs pool, put the real usage into the answer and mark it
 * (`CEPHFS_USAGE_SOURCE_KEY`). Any other answer, or a read that fails or runs
 * past the budget, passes through unchanged: the Backend treats an unmarked
 * CephFS usage as unknown.
 */
export class CephfsUsage {
  private readonly drivers = new Map<string, { driver: string; at: number }>();

  constructor(private readonly deps: CephfsUsageDeps) {}

  async apply(method: string, path: string, response: LocalIncusResponse, signal: AbortSignal): Promise<LocalIncusResponse> {
    if (method !== 'GET' || response.status !== 200) return response;
    const [pathname, query = ''] = path.split('?', 2);
    const project = new URLSearchParams(query).get('project');
    if (project !== null && project !== 'default') return response;
    const match = STATE_PATH.exec(pathname!);
    if (!match) return response;
    const [, pool, volume] = match as unknown as [string, string, string];
    const budget = AbortSignal.any([signal, AbortSignal.timeout(CEPHFS_USAGE_BUDGET_MS)]);
    try {
      return await withDeadline(this.rewrite(pool, volume, response, budget), budget);
    } catch (error) {
      this.deps.log(`cephfs usage of ${pool}/${volume} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return response;
    }
  }

  private async rewrite(pool: string, volume: string, response: LocalIncusResponse, signal: AbortSignal): Promise<LocalIncusResponse> {
    if (await this.driver(pool, signal) !== 'cephfs') return response;
    const document = JSON.parse(response.body.toString('utf8')) as { metadata?: { usage?: Record<string, unknown> } };
    const usage = document.metadata?.usage;
    if (!usage || typeof usage !== 'object') return response;
    usage.used = await this.deps.readRbytes(join(this.deps.incusDir, 'storage-pools', pool, 'custom', `default_${volume}`), signal);
    usage[CEPHFS_USAGE_SOURCE_KEY] = CEPHFS_USAGE_SOURCE_RBYTES;
    const headers = { ...response.headers };
    delete headers['content-length'];
    return { status: response.status, headers, body: Buffer.from(JSON.stringify(document)) };
  }

  private async driver(pool: string, signal: AbortSignal): Promise<string | undefined> {
    const cached = this.drivers.get(pool);
    if (cached && Date.now() - cached.at < DRIVER_CACHE_MS) return cached.driver;
    const answer = await this.deps.incus.request({
      method: 'GET',
      path: `/1.0/storage-pools/${pool}`,
      timeoutMs: CEPHFS_USAGE_BUDGET_MS,
      signal,
    });
    if (answer.status !== 200) return undefined;
    const driver = (JSON.parse(answer.body.toString('utf8')) as { metadata?: { driver?: unknown } }).metadata?.driver;
    if (typeof driver !== 'string') return undefined;
    this.drivers.set(pool, { driver, at: Date.now() });
    return driver;
  }
}

/** Settles when `signal` aborts even if `work` never does (getfattr stuck on a hung mount). */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('cephfs usage read aborted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
