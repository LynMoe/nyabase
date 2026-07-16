import type { RemoteFsMountSpec } from '@nyabase/common';

/**
 * The requested filesystem state may already have been reached, but a
 * security-sensitive teardown step (for example, deleting a Ceph secret)
 * could not be proven complete. Callers must keep the task retryable instead
 * of converting this into a successful terminal result.
 */
export class FsCleanupIncompleteError extends Error {
  constructor(
    message: string,
    readonly cleanupCause?: unknown,
  ) {
    super(message);
    this.name = 'FsCleanupIncompleteError';
  }
}

export interface SelfCheckItem {
  id: string;
  label: string;
  status: 'ok' | 'fail' | 'warn';
  message: string;
}

export interface FsMountDriver {
  readonly type: string;

  /** Optional pre-mount setup (e.g. write keyring file) */
  prepare?(spec: RemoteFsMountSpec): Promise<void>;

  /** Execute the mount syscall; throws on failure */
  mount(spec: RemoteFsMountSpec): Promise<void>;

  /**
   * Returns true if the current /proc/mounts entry already matches the spec,
   * meaning no remount is needed.
   */
  matchesCurrent(spec: RemoteFsMountSpec, current: { src: string; opts: string }): boolean;

  /** Optional post-umount teardown (e.g. remove keyring file) */
  cleanup?(spec: RemoteFsMountSpec): Promise<void>;

  /** Self-check: verify required binaries / kernel modules are present */
  selfCheck(): Promise<SelfCheckItem>;
}
