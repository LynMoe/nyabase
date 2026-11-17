import {
  CONTAINER_SCRIPT_GUEST_RUNS_DIR,
  CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES,
  MAX_AGENT_INCUS_REQUEST_BODY_BYTES,
  type ContainerScriptFileDestination,
  type ContainerScriptRunStatus,
} from '@nyabase/common';
import {
  IncusError,
  isOperationWaitNotFound,
  operationIdFromResponse,
  type IncusClientPort,
} from '../incus/index.js';
import { runStatusFromGuest } from './container-script-rules.js';
import { buildWrapper, guestRunDirectory } from './container-script-wrapper.js';

/*
 * One run in one container, through the server's agent (exec and the files
 * API only, the same requests the SSH key sync makes):
 *
 *  1. read the instance: it must be running, and (every boot) in the boot the
 *     target is for; its `last_used_at` is the run's boot id;
 *  2. push the script, the files and the wrapper (container-script-wrapper.ts)
 *     into the run directory, in chunks the agent tunnel admits;
 *  3. exec the wrapper and wait for the operation; if the Backend loses the
 *     operation (agent reconnect), watch the run directory for `rc` instead;
 *  4. read `rc`, `output` and `timed_out`, then remove the directory.
 *
 * Until the exec is sent nothing ran in the guest: a failure there abandons
 * the start (the attempt does not count). After it, the run always ends with
 * a status, `interrupted` when its outcome cannot be known.
 */

export type FinishedStatus = Exclude<ContainerScriptRunStatus, 'running'>;

export type RunResult =
  | { readonly kind: 'abandoned'; readonly reason: string }
  | {
    readonly kind: 'finished';
    readonly status: FinishedStatus;
    readonly exitCode: number | null;
    readonly output: string;
    readonly error: string | null;
    readonly bootId: string | null;
  };

export interface RunFile {
  readonly name: string;
  readonly sha256: string;
  readonly destination: ContainerScriptFileDestination | null;
}

export interface RunSpec {
  readonly runId: string;
  readonly serverId: string;
  readonly instanceName: string;
  readonly timeoutSeconds: number;
  readonly script: string;
  readonly files: readonly RunFile[];
  readonly environment: Readonly<Record<string, string>>;
  /** Every boot: the boot the target is due for; null when any boot will do. */
  readonly expectedBootId: string | null;
  readonly deadline: Date;
}

/** What resuming the watch of a run the Backend lost track of needs. */
export interface WatchSpec {
  readonly runId: string;
  readonly serverId: string;
  readonly instanceName: string;
  readonly bootId: string | null;
  readonly deadline: Date;
}

export interface RunnerDeps {
  readonly client: (serverId: string) => Promise<IncusClientPort>;
  readonly blob: (sha256: string) => Promise<Buffer>;
  readonly recordBoot: (runId: string, bootId: string | null) => Promise<void>;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now: () => number;
}

/** Below the tunnel's request body limit, leaving room for the frame around it. */
export const PUSH_CHUNK_BYTES = Math.min(768 * 1024, MAX_AGENT_INCUS_REQUEST_BODY_BYTES);
const OPERATION_WAIT_MS = 30_000;
const RESULT_POLL_MS = 10_000;
/** How long after the exec ended a missing `rc` is still waited for. */
const ENDED_GRACE_MS = 3_000;

/** Incus `last_used_at` of a started instance; never-started instances report the zero time. */
export function bootIdOf(lastUsedAt: unknown): string | null {
  if (typeof lastUsedAt !== 'string' || lastUsedAt === '') return null;
  if (lastUsedAt.startsWith('0001-01-01') || lastUsedAt.startsWith('1970-01-01')) return null;
  return lastUsedAt;
}

function describe(error: unknown): string {
  if (error instanceof IncusError) {
    const detail = typeof error.details?.error === 'string' ? `: ${error.details.error}` : '';
    return `${error.code}${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isUnreachable(error: unknown): boolean {
  return error instanceof IncusError && (error.code === 'SERVER_UNREACHABLE' || error.code === 'INCUS_TIMEOUT');
}

function isNotRunning(error: unknown): boolean {
  return error instanceof IncusError
    && (error.code === 'INCUS_BAD_REQUEST' || error.code === 'INSTANCE_BUSY' || error.code === 'INCUS_NOT_FOUND')
    && /not running|busy|not found/i.test(String(error.details?.error ?? error.message));
}

/** The request never left: no agent was connected to carry it (not one lost in flight). */
function wasNotSent(error: unknown): boolean {
  return error instanceof IncusError
    && error.code === 'SERVER_UNREACHABLE'
    && error.details?.reason === 'agent_disconnected'
    && error.details?.phase !== 'in_flight';
}

function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

async function instanceState(client: IncusClientPort, name: string, signal: AbortSignal) {
  const instance = (await client.getInstance(name, { signal })).metadata;
  return { running: instance?.status === 'Running', bootId: bootIdOf(instance?.last_used_at) };
}

async function ensureDirectory(client: IncusClientPort, name: string, path: string, mode: number, signal: AbortSignal) {
  try {
    const existing = await client.getFile(name, path, { signal });
    if (existing.type === 'directory') return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await client.putFile(name, path, Buffer.alloc(0), { uid: 0, gid: 0, mode, type: 'directory', signal });
}

async function pushFile(client: IncusClientPort, name: string, path: string, content: Buffer, mode: number, signal: AbortSignal) {
  let offset = 0;
  do {
    const chunk = content.subarray(offset, offset + PUSH_CHUNK_BYTES);
    await client.putFile(name, path, chunk, {
      uid: 0,
      gid: 0,
      mode,
      type: 'file',
      write: offset === 0 ? 'overwrite' : 'append',
      signal,
    });
    offset += chunk.byteLength;
  } while (offset < content.byteLength);
}

async function readGuestFile(client: IncusClientPort, name: string, path: string, signal: AbortSignal): Promise<Buffer | null> {
  try {
    const file = await client.getFile(name, path, { signal });
    return file.type === 'directory' ? null : file.body;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Text of the output tail: valid UTF-8, no NUL, within the kept size. */
export function outputText(body: Buffer | null): string {
  if (!body) return '';
  const tail = body.byteLength > CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES
    ? body.subarray(body.byteLength - CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES)
    : body;
  return tail.toString('utf8').replaceAll('\u0000', '');
}

async function readResult(client: IncusClientPort, name: string, dir: string, signal: AbortSignal) {
  const rcBody = await readGuestFile(client, name, `${dir}/rc`, signal);
  if (rcBody === null) return null;
  const rc = Number.parseInt(rcBody.toString('utf8').trim(), 10);
  const [output, timedOut] = await Promise.all([
    readGuestFile(client, name, `${dir}/output`, signal),
    readGuestFile(client, name, `${dir}/timed_out`, signal),
  ]);
  return { rc: Number.isFinite(rc) ? rc : null, output: outputText(output), timedOut: timedOut !== null };
}

function finished(
  status: FinishedStatus,
  bootId: string | null,
  fields: { exitCode?: number | null; output?: string; error?: string | null } = {},
): RunResult {
  return {
    kind: 'finished',
    status,
    exitCode: fields.exitCode ?? null,
    output: fields.output ?? '',
    error: fields.error ?? null,
    bootId,
  };
}

/** Removes the run directory; best effort (the wrapper sweeps leftovers after 7 days). */
async function cleanup(client: IncusClientPort, name: string, dir: string, signal: AbortSignal): Promise<void> {
  try {
    await client.execInstance(name, { command: ['rm', '-rf', '--', dir], 'record-output': false }, { signal });
  } catch {
    // The next run's sweep removes it.
  }
}

export async function executeRun(deps: RunnerDeps, spec: RunSpec, signal: AbortSignal): Promise<RunResult> {
  const client = await deps.client(spec.serverId);
  const name = spec.instanceName;
  let bootId: string | null;
  try {
    const state = await instanceState(client, name, signal);
    if (!state.running) return { kind: 'abandoned', reason: 'container_not_running' };
    if (spec.expectedBootId !== null && state.bootId !== spec.expectedBootId) {
      return { kind: 'abandoned', reason: 'container_rebooted' };
    }
    bootId = state.bootId;
  } catch (error) {
    signal.throwIfAborted();
    return { kind: 'abandoned', reason: describe(error) };
  }
  await deps.recordBoot(spec.runId, bootId);
  const dir = guestRunDirectory(spec.runId);
  try {
    await ensureDirectory(client, name, '/var/lib/nyabase', 0o755, signal);
    await ensureDirectory(client, name, CONTAINER_SCRIPT_GUEST_RUNS_DIR, 0o700, signal);
    await ensureDirectory(client, name, dir, 0o700, signal);
    await ensureDirectory(client, name, `${dir}/files`, 0o700, signal);
    await pushFile(client, name, `${dir}/script`, Buffer.from(spec.script, 'utf8'), 0o700, signal);
    for (const file of spec.files) {
      await pushFile(client, name, `${dir}/files/${file.name}`, await deps.blob(file.sha256), 0o600, signal);
    }
    const wrapper = buildWrapper({
      runId: spec.runId,
      timeoutSeconds: spec.timeoutSeconds,
      files: spec.files,
      environment: spec.environment,
    });
    await pushFile(client, name, `${dir}/wrapper`, Buffer.from(wrapper, 'utf8'), 0o700, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (isUnreachable(error) || isNotRunning(error)) return { kind: 'abandoned', reason: describe(error) };
    await cleanup(client, name, dir, signal);
    return finished('failed', bootId, { error: `Could not copy the script into the container (${describe(error)})` });
  }
  let operationId: string | null = null;
  try {
    const response = await client.execInstance(name, {
      command: ['/bin/sh', `${dir}/wrapper`],
      'record-output': false,
      interactive: false,
      'wait-for-websocket': false,
    }, { signal });
    operationId = operationIdFromResponse(response);
  } catch (error) {
    signal.throwIfAborted();
    if (isNotRunning(error) || wasNotSent(error)) return { kind: 'abandoned', reason: describe(error) };
    // The exec may or may not have started: only the guest can tell.
  }
  const result = await awaitResult(deps, client, { ...spec, bootId }, operationId, signal);
  await cleanup(client, name, dir, signal);
  return result;
}

/** Resumes waiting for a run whose exec this process did not start (a Backend restart). */
export async function watchRun(deps: RunnerDeps, spec: WatchSpec, signal: AbortSignal): Promise<RunResult> {
  const client = await deps.client(spec.serverId);
  const result = await awaitResult(deps, client, spec, null, signal);
  await cleanup(client, spec.instanceName, guestRunDirectory(spec.runId), signal);
  return result;
}

async function awaitResult(
  deps: RunnerDeps,
  client: IncusClientPort,
  spec: WatchSpec,
  initialOperationId: string | null,
  signal: AbortSignal,
): Promise<RunResult> {
  const name = spec.instanceName;
  const dir = guestRunDirectory(spec.runId);
  let operationId = initialOperationId;
  /** When the exec was seen to end: the wrapper writes `rc` before it exits. */
  let endedAt: number | null = null;
  while (deps.now() < spec.deadline.getTime()) {
    signal.throwIfAborted();
    if (operationId !== null) {
      try {
        const waited = await client.getOperationWait(operationId, {
          timeoutMs: Math.max(1_000, Math.min(OPERATION_WAIT_MS, spec.deadline.getTime() - deps.now())),
          signal,
        });
        const status = waited.metadata?.status;
        if (status === 'Running' || status === 'Pending') continue;
        operationId = null;
        endedAt = deps.now();
      } catch (error) {
        signal.throwIfAborted();
        // Lost (agent reconnect, operation expired): fall back to the run directory.
        operationId = null;
        if (!isOperationWaitNotFound(error)) await deps.sleep(5_000, signal);
      }
    }
    try {
      const result = await readResult(client, name, dir, signal);
      if (result) {
        const outcome = runStatusFromGuest(result);
        return finished(outcome.status, spec.bootId, { exitCode: outcome.exitCode, output: result.output, error: outcome.error });
      }
      const state = await instanceState(client, name, signal);
      if (!state.running || (spec.bootId !== null && state.bootId !== spec.bootId)) {
        return finished('interrupted', spec.bootId, { error: 'The container stopped or rebooted during the run' });
      }
      if (endedAt !== null && deps.now() - endedAt >= ENDED_GRACE_MS) {
        return finished('failed', spec.bootId, {
          error: 'The wrapper exited without a result (the guest needs /bin/sh and coreutils)',
        });
      }
    } catch (error) {
      signal.throwIfAborted();
      if (isNotFound(error)) {
        return finished('interrupted', spec.bootId, { error: 'The container no longer exists' });
      }
      // Agent away: keep waiting until the deadline.
    }
    await deps.sleep(endedAt === null ? RESULT_POLL_MS : 1_000, signal);
  }
  return finished('interrupted', spec.bootId, { error: 'No result before the run deadline' });
}
