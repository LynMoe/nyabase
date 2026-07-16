import { spawn, type ChildProcess } from 'child_process';
import {
  PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE,
  PHYSICAL_MUTATION_LOCK_PATH,
  PhysicalMutationFenceBusyError,
  fencePhysicalMutationCommand,
} from '../physical-mutation-fence.js';

export class IsolatedCommandTimeoutError extends Error {
  readonly ambiguous = true;

  constructor(
    readonly command: string,
    readonly timeoutMs: number,
  ) {
    super(`${command} exceeded ${timeoutMs}ms; the Agent must stop until its fenced process group exits`);
    this.name = 'IsolatedCommandTimeoutError';
  }
}

export { PhysicalMutationFenceBusyError } from '../physical-mutation-fence.js';

export type IsolatedCommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<void>;

export interface IsolatedCommandRunnerOptions {
  lockPath?: string;
  fatalHook?: (error: IsolatedCommandTimeoutError) => void;
  spawnProcess?: typeof spawn;
}

function killAgentAfterAmbiguousIsolatedCommand(error: IsolatedCommandTimeoutError): void {
  console.error(`[PhysicalMutation] ${error.message}`);
  process.kill(process.pid, 'SIGKILL');
}

/**
 * Every OS-level mutation is exec'd under one stable-inode flock. --no-fork
 * makes the real helper retain the locked open-file description after its
 * parent Agent is killed, fencing a replacement Agent until true process exit.
 */
export function createIsolatedCommandRunner(
  options: IsolatedCommandRunnerOptions = {},
): IsolatedCommandRunner {
  const lockPath = options.lockPath ?? PHYSICAL_MUTATION_LOCK_PATH;
  const fatalHook = options.fatalHook ?? killAgentAfterAmbiguousIsolatedCommand;
  const spawnProcess = options.spawnProcess ?? spawn;
  let poisoned = false;

  return (command, args, timeoutMs) => {
    if (poisoned) return new Promise<void>(() => { /* process is terminating */ });
    const fenced = fencePhysicalMutationCommand(command, args, lockPath);
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnProcess(fenced.executable, fenced.args, {
          detached: true,
          stdio: 'ignore',
        });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let ambiguous = false;
      const finish = (error?: Error): void => {
        if (settled || ambiguous) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const failStop = (reason: string): void => {
        if (settled || ambiguous) return;
        ambiguous = true;
        poisoned = true;
        clearTimeout(timer);
        killProcessGroup(child);
        const error = new IsolatedCommandTimeoutError(`${command} (${reason})`, timeoutMs);
        try {
          fatalHook(error);
        } catch (fatalError) {
          console.error('[PhysicalMutation] Injected fatal hook failed; forcing SIGKILL', fatalError);
          killAgentAfterAmbiguousIsolatedCommand(error);
        }
      };
      const timer = setTimeout(() => failStop('deadline exceeded'), timeoutMs);
      timer.unref();

      child.once('error', (error) => {
        if (child.pid === undefined) finish(error);
        else failStop(`process transport failed after spawn: ${error.message}`);
      });
      child.once('close', (code, signal) => {
        if (ambiguous) return;
        if (isProcessGroupAlive(child.pid)) {
          failStop('leader closed while a descendant retained the process group');
          return;
        }
        if (code === 0) {
          finish();
          return;
        }
        if (code === PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE) {
          finish(new PhysicalMutationFenceBusyError(command));
          return;
        }
        finish(new Error(
          `${command} exited without success (code=${String(code)}, signal=${String(signal)})`,
        ));
      });
    });
  };
}

export const runIsolatedCommand: IsolatedCommandRunner = createIsolatedCommandRunner();

function isProcessGroupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function killProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}
