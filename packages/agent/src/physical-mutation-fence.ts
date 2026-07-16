import * as fs from 'fs';
import * as path from 'path';

/**
 * This inode is host-stable across Agent service restarts. Never unlink it.
 * A physical helper inherits the flock open-file description across exec, so
 * killing its parent Agent cannot let a replacement overlap the helper.
 */
export const PHYSICAL_MUTATION_LOCK_PATH = '/var/lib/nyabase-agent/physical-mutation.lock';
export const PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE = 75;

export class PhysicalMutationFenceBusyError extends Error {
  constructor(readonly command: string) {
    super(`Physical mutation fence is held by a previous Agent helper: ${command}`);
    this.name = 'PhysicalMutationFenceBusyError';
  }
}

export interface FencedCommand {
  executable: 'flock';
  args: string[];
}

export function ensurePhysicalMutationFence(lockPath = PHYSICAL_MUTATION_LOCK_PATH): void {
  const canonical = path.resolve(lockPath);
  if (canonical !== lockPath || !path.isAbsolute(lockPath) || lockPath.includes('\0')) {
    throw new Error(`Invalid physical mutation lock path: ${lockPath}`);
  }
  const directory = path.dirname(lockPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory()
    || directoryStat.isSymbolicLink()
    || directoryStat.uid !== 0
    || (directoryStat.mode & 0o022) !== 0
  ) {
    throw new Error(`Unsafe physical mutation lock directory: ${directory}`);
  }

  const fd = fs.openSync(
    lockPath,
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0) {
      throw new Error(`Unsafe physical mutation lock file: ${lockPath}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * --no-fork is essential: flock execs the real helper, which keeps the locked
 * open-file description itself. The lock therefore outlives a killed Agent.
 */
export function fencePhysicalMutationCommand(
  executable: string,
  args: readonly string[],
  lockPath = PHYSICAL_MUTATION_LOCK_PATH,
): FencedCommand {
  ensurePhysicalMutationFence(lockPath);
  return {
    executable: 'flock',
    args: [
      '--exclusive',
      '--nonblock',
      '--conflict-exit-code',
      String(PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE),
      '--no-fork',
      lockPath,
      executable,
      ...args,
    ],
  };
}

export function unwrapFencedCommandForTest(
  executable: string,
  args: readonly string[],
): { executable: string; args: readonly string[] } {
  if (executable !== 'flock') return { executable, args };
  const lockPathIndex = 5;
  const commandIndex = lockPathIndex + 1;
  const command = args[commandIndex];
  if (!command) throw new Error('Malformed fenced command');
  return { executable: command, args: args.slice(commandIndex + 1) };
}
