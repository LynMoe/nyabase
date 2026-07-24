import { spawn, type ChildProcess } from 'child_process';
import {
  PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE,
  PHYSICAL_MUTATION_LOCK_PATH,
  PhysicalMutationFenceBusyError,
  fencePhysicalMutationCommand,
} from '../physical-mutation-fence.js';

export class RemoteDataDirHelperAmbiguityError extends Error {
  readonly ambiguous = true;
  constructor(readonly operation: string, readonly reason: string) {
    super(`Remote DataDir helper became ambiguous during ${operation}: ${reason}`);
    this.name = 'RemoteDataDirHelperAmbiguityError';
  }
}

export class RemoteDataDirHelperError extends Error {
  constructor(
    readonly remoteName: string,
    message: string,
    readonly remoteOperation?: string,
  ) {
    super(message);
    this.name = 'RemoteDataDirHelperError';
  }
}

export type RemoteDataDirHelperRunner = (operation: string, payload: unknown) => Promise<unknown>;

export interface RemoteDataDirHelperRunnerOptions {
  command: (payload: unknown) => { executable: string; args: readonly string[] };
  timeoutMs: number;
  outputLimitBytes: number;
  lockPath?: string;
  spawnProcess?: typeof spawn;
  fatalHook: (error: RemoteDataDirHelperAmbiguityError) => void;
}

/** A killable, output-bounded helper lane; timeout never settles the caller. */
export function createRemoteDataDirHelperRunner(
  options: RemoteDataDirHelperRunnerOptions,
): RemoteDataDirHelperRunner {
  const spawnProcess = options.spawnProcess ?? spawn;
  const lockPath = options.lockPath ?? PHYSICAL_MUTATION_LOCK_PATH;
  let poisoned = false;

  return (operation, payload) => {
    if (poisoned) return new Promise<unknown>(() => { /* process is terminating */ });
    const command = options.command(payload);
    const fenced = fencePhysicalMutationCommand(command.executable, command.args, lockPath);
    return new Promise<unknown>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnProcess(fenced.executable, fenced.args, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(error);
        return;
      }

      let settled = false;
      let ambiguous = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      const timer = setTimeout(() => failStop(`deadline exceeded after ${options.timeoutMs}ms`), options.timeoutMs);
      timer.unref();

      const finish = (error?: Error, value?: unknown) => {
        if (settled || ambiguous) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const failStop = (reason: string) => {
        if (settled || ambiguous) return;
        ambiguous = true;
        poisoned = true;
        clearTimeout(timer);
        killProcessGroup(child);
        const error = new RemoteDataDirHelperAmbiguityError(operation, reason);
        try { options.fatalHook(error); } catch { /* caller's fatal boundary owns process death */ }
      };
      const collect = (stream: 'stdout' | 'stderr', chunk: string | Buffer) => {
        if (settled || ambiguous) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (stream === 'stdout') stdout = Buffer.concat([stdout, bytes]);
        else stderr = Buffer.concat([stderr, bytes]);
        if (stdout.length + stderr.length > options.outputLimitBytes) {
          failStop(`output exceeded ${options.outputLimitBytes} bytes`);
        }
      };
      child.stdout?.on('data', (chunk: string | Buffer) => collect('stdout', chunk));
      child.stderr?.on('data', (chunk: string | Buffer) => collect('stderr', chunk));
      child.stdout?.once('error', (error) => failStop(`stdout transport failed: ${error.message}`));
      child.stderr?.once('error', (error) => failStop(`stderr transport failed: ${error.message}`));
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
        if (code === PHYSICAL_MUTATION_FENCE_CONFLICT_EXIT_CODE) {
          finish(new PhysicalMutationFenceBusyError(command.executable));
          return;
        }
        if (code !== 0) {
          failStop(`helper exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
          return;
        }
        let envelope: unknown;
        try { envelope = JSON.parse(stdout.toString('utf8')); } catch {
          failStop(`helper returned invalid JSON (${stderr.toString('utf8').slice(0, 256)})`);
          return;
        }
        if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
          failStop('helper returned an invalid envelope');
          return;
        }
        const record = envelope as Record<string, unknown>;
        if (record.ok === true) {
          finish(undefined, record.data);
          return;
        }
        if (record.ok === false && record.error && typeof record.error === 'object') {
          const remote = record.error as Record<string, unknown>;
          finish(new RemoteDataDirHelperError(
            typeof remote.name === 'string' ? remote.name : 'Error',
            typeof remote.message === 'string' ? remote.message : 'Remote DataDir helper failed',
            typeof remote.operation === 'string' ? remote.operation : undefined,
          ));
          return;
        }
        failStop('helper returned an invalid result envelope');
      });
    });
  };
}

function isProcessGroupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try { process.kill(-pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function killProcessGroup(child: ChildProcess): void {
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}
