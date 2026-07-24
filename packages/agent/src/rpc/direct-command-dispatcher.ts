import { execFile } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import {
  type AgentToBackendMessage,
  type BackendToAgentMessage,
  type RemoteFsMountSpec,
  type SelfCheckItem,
  type SelfCheckResult,
  LABEL,
  isDirectWsCommandKind,
  zAgentBootstrapPayload,
  zAgentBootstrapResult,
  zCommandAckPayload,
  zExecClosePayload,
  zExecInputPayload,
  zExecResizePayload,
  zExecStreamPayload,
  zInspectContainerPayload,
  zInspectContainerResult,
  zReconcilePayload,
  zSelfCheckResult,
} from '@nyabase/common';
import type { AgentConfig } from '../config.js';
import type { DockerClient } from '../docker/docker-client.js';
import type { DropbearManager } from '../dropbear/dropbear-manager.js';
import type { RemoteFsMounter } from '../fs/remote-fs-mounter.js';
import type { XfsQuotaManager } from '../quota/xfs-quota.js';
import type { AgentWsClient } from '../ws/client.js';

const execFileAsync = promisify(execFile);

type ExecHandles = {
  kill(): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  write(data: string): boolean;
};

type ExecSession = {
  handles: ExecHandles;
  generation: number;
  runtimeId: string;
  closing: Promise<void> | null;
  controlTail: Promise<void>;
};

type PendingExecSession = {
  generation: number;
  runtimeId: string;
  opening: Promise<void> | null;
  inputs: string[];
  inputChars: number;
  resize?: { cols: number; rows: number };
  close: boolean;
};

const HANDLED = Symbol('handled');
export const MAX_EXEC_SESSIONS = 16;
export const MAX_PENDING_EXEC_SESSIONS = 16;
const MAX_PENDING_INPUT_CHARS = 128 * 1024;
const MAX_PENDING_INPUT_CHUNKS = 256;

/** Interactive request/response RPC. Durable lifecycle effects never enter here. */
export class DirectCommandDispatcher {
  private readonly execSessions = new Map<string, ExecSession>();
  private readonly pendingExecSessions = new Map<string, PendingExecSession>();
  private readonly physicalExecWork = new Set<Promise<void>>();
  private readonly runtimeTaskFences = new Map<string, symbol>();
  private physicalExecFailure: unknown = null;
  private connectionGeneration = 0;

  constructor(
    private readonly config: AgentConfig,
    private readonly docker: DockerClient,
    private readonly remoteFsMounter: RemoteFsMounter,
    private readonly ws: AgentWsClient,
    private readonly dropbear: DropbearManager,
    private readonly quota: XfsQuotaManager,
    private readonly onRemoteFsSnapshot?: (
      specs: readonly RemoteFsMountSpec[],
      previousIds: readonly string[],
    ) => void,
    private readonly beforeAgentBootstrap?: () => Promise<void>,
    private readonly assertRuntimePhysicalEnvironment: () => Promise<void> = async () => undefined,
  ) {}

  async handle(message: BackendToAgentMessage): Promise<void> {
    const commandId = message.id ?? '';
    const requestGeneration = this.connectionGeneration;
    if (!isDirectWsCommandKind(message.kind)) {
      throw new Error(`Message ${message.kind} is not a direct RPC`);
    }
    try {
      const result = await this.execute(message.kind, message.payload, commandId);
      if (result !== HANDLED) this.ack(commandId, true, result, undefined, requestGeneration);
    } catch (error) {
      console.error(`[DirectRPC] ${message.kind} failed:`, error);
      this.ack(
        commandId,
        false,
        undefined,
        (error instanceof Error ? error.message : String(error)).slice(0, 2048) || 'Direct RPC failed',
        requestGeneration,
      );
    }
  }

  /** A transport disconnect invalidates every interactive session on this connection. */
  resetConnection(): void {
    this.connectionGeneration += 1;
    for (const pending of this.pendingExecSessions.values()) {
      pending.close = true;
      pending.inputs = [];
      pending.inputChars = 0;
      pending.resize = undefined;
    }
    for (const [sessionId, session] of this.execSessions) {
      void this.closeExecSession(sessionId, session).catch((error) => {
        // The Docker implementation fail-stops instead of rejecting when it
        // cannot prove physical exit. Retain the owner if an injected/test
        // implementation violates that contract.
        console.error(`[DirectRPC] Exec ${sessionId} disconnect close failed:`, error);
      });
    }
  }

  /**
   * Join every exec open/close operation admitted before this call. A stable
   * active shell is not global work; once closing starts, its physical barrier
   * is synchronously tracked so lifecycle tasks cannot overtake a late
   * container-stop fallback.
   */
  async waitForIdle(): Promise<void> {
    if (this.physicalExecFailure) throw this.physicalExecFailure;
    // Snapshot admission: work registered after this call belongs to a later
    // message and must not let unrelated console churn starve a durable task
    // or reconnect forever. Each captured open/close Promise already includes
    // all cleanup causally spawned by that operation.
    const admitted = Array.from(this.physicalExecWork);
    await Promise.all(admitted);
    if (this.physicalExecFailure) throw this.physicalExecFailure;
  }

  /** Close only shells attached to the exact runtime owned by a durable task. */
  async closeByRuntime(runtimeId: string): Promise<void> {
    const barriers: Promise<void>[] = [];
    for (const pending of this.pendingExecSessions.values()) {
      if (pending.runtimeId !== runtimeId) continue;
      pending.close = true;
      pending.inputs = [];
      pending.inputChars = 0;
      pending.resize = undefined;
      if (pending.opening) barriers.push(pending.opening);
    }
    for (const [sessionId, session] of this.execSessions) {
      if (session.runtimeId !== runtimeId) continue;
      barriers.push(this.closeExecSession(sessionId, session));
    }
    await Promise.all(barriers);
  }

  /**
   * Fence one exact runtime for the complete physical handler window. Existing
   * sessions are closed before the lease is returned; late pre-commit console
   * RPCs are rejected until the caller releases the identity-guarded lease.
   */
  async acquireRuntimeTaskFence(runtimeId: string): Promise<() => void> {
    if (this.runtimeTaskFences.has(runtimeId)) {
      throw new Error(`Runtime ${runtimeId} already has an active durable task fence`);
    }
    const token = Symbol(runtimeId);
    this.runtimeTaskFences.set(runtimeId, token);
    try {
      await this.closeByRuntime(runtimeId);
    } catch (error) {
      // A failed physical close is fail-closed: retain the fence. Production
      // Docker barriers either resolve after proof or terminate the Agent.
      this.physicalExecFailure ??= error;
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.runtimeTaskFences.get(runtimeId) === token) {
        this.runtimeTaskFences.delete(runtimeId);
      }
    };
  }

  private async execute(kind: string, payload: unknown, commandId: string): Promise<unknown | typeof HANDLED> {
    switch (kind) {
      case 'execStream':
        this.openExec(commandId, zExecStreamPayload.parse(payload));
        return HANDLED;
      case 'execResize': {
        const parsed = zExecResizePayload.parse(payload);
        const session = this.execSessions.get(parsed.sessionId);
        if (
          session
          && session.generation === this.connectionGeneration
          && session.closing === null
        ) {
          await this.enqueueActiveExecControl(parsed.sessionId, session, async () => {
            await session.handles.resize(parsed.cols, parsed.rows);
          });
        }
        else {
          const pending = this.pendingExecSessions.get(parsed.sessionId);
          if (
            pending
            && pending.generation === this.connectionGeneration
            && !pending.close
          ) pending.resize = { cols: parsed.cols, rows: parsed.rows };
        }
        return HANDLED;
      }
      case 'execInput': {
        const parsed = zExecInputPayload.parse(payload);
        const session = this.execSessions.get(parsed.sessionId);
        if (
          session
          && session.generation === this.connectionGeneration
          && session.closing === null
        ) {
          await this.enqueueActiveExecControl(parsed.sessionId, session, async () => {
            if (session.handles.write(parsed.data) === false) {
              throw new Error(`Exec session ${parsed.sessionId} exceeded stdin backpressure`);
            }
          });
        }
        else {
          const pending = this.pendingExecSessions.get(parsed.sessionId);
          // execStream synchronously reserves a pending row before acknowledging;
          // controls for any other ID are stale or hostile and must not allocate.
          if (
            !pending
            || pending.generation !== this.connectionGeneration
            || pending.close
          ) return HANDLED;
          if (
            pending.inputs.length >= MAX_PENDING_INPUT_CHUNKS
            || pending.inputChars + parsed.data.length > MAX_PENDING_INPUT_CHARS
          ) {
            pending.close = true;
            pending.inputs = [];
            pending.inputChars = 0;
            throw new Error(`Exec session ${parsed.sessionId} exceeded the pending input limit`);
          }
          pending.inputs.push(parsed.data);
          pending.inputChars += parsed.data.length;
        }
        return HANDLED;
      }
      case 'execClose': {
        const parsed = zExecClosePayload.parse(payload);
        const session = this.execSessions.get(parsed.sessionId);
        if (session) {
          await this.closeExecSession(parsed.sessionId, session);
        } else {
          const pending = this.pendingExecSessions.get(parsed.sessionId);
          if (pending) pending.close = true;
        }
        return HANDLED;
      }
      case 'reconcile': {
        const parsed = zReconcilePayload.parse(payload);
        if (parsed.serverId !== this.config.serverId) {
          throw new Error('Reconcile server identity mismatch');
        }
        this.ws.emit('reconcile', parsed);
        return HANDLED;
      }
      case 'inspectContainer': {
        const parsed = zInspectContainerPayload.parse(payload);
        return this.withRuntimePhysicalGuard(async () => {
          const info = await this.docker.inspectContainer(parsed.runtimeId);
          const labels = info.Config?.Labels ?? {};
          if (info.Id !== parsed.runtimeId) {
            throw new Error(`Runtime identity mismatch for ${parsed.runtimeId}`);
          }
          if (
            labels[LABEL.MANAGED] !== 'true'
            || labels[LABEL.CONTAINER_ID] !== parsed.containerId
            || labels[LABEL.SERVER_ID] !== this.config.serverId
          ) {
            throw new Error(`Container ${parsed.runtimeId} is not the requested managed container`);
          }
          const graph = await this.docker.getGraphDriverDirs(parsed.runtimeId);
          const graphPaths = Array.from(new Set([graph.upperDir, graph.workDir]
            .map((value) => value.trim())
            .filter(Boolean)));
          return zInspectContainerResult.parse({
            runtimeId: info.Id,
            startedAt: info.State.StartedAt,
            running: Boolean(info.State.Running),
            graphPaths,
          });
        });
      }
      case 'agent.bootstrap.v1': {
        const parsed = zAgentBootstrapPayload.parse(payload);
        await this.beforeAgentBootstrap?.();
        const previousIds = this.remoteFsMounter.getAllSpecs().map((spec) => spec.id);
        const remoteFsMounts = await this.remoteFsMounter.adoptSnapshot(parsed.remoteFsMounts);
        const result = zAgentBootstrapResult.parse({ remoteFsMounts });
        const activeSpecs = parsed.remoteFsMounts.map((spec) => {
          const active = this.remoteFsMounter.getSpec(spec.id);
          if (!active) throw new Error(`RemoteFS bootstrap lost active spec ${spec.id}`);
          return active;
        });
        this.onRemoteFsSnapshot?.(activeSpecs, previousIds);
        return result;
      }
      case 'selfCheck':
        return this.withRuntimePhysicalGuard(async () =>
          zSelfCheckResult.parse(await this.selfCheck()));
      default:
        throw new Error(`Unsupported direct RPC ${kind}`);
    }
  }

  private openExec(commandId: string, payload: ReturnType<typeof zExecStreamPayload.parse>): void {
    if (this.runtimeTaskFences.has(payload.runtimeId)) {
      throw new Error(`Runtime ${payload.runtimeId} is fenced by a durable task`);
    }
    if (this.execSessions.has(payload.sessionId) || this.pendingExecSessions.has(payload.sessionId)) {
      throw new Error(`Exec session ${payload.sessionId} already exists`);
    }
    if (this.execSessions.size + this.pendingExecSessions.size >= MAX_EXEC_SESSIONS) {
      throw new Error(`Agent exec session limit (${MAX_EXEC_SESSIONS}) reached`);
    }
    const openingGeneration = this.connectionGeneration;
    const reservation = this.pendingExec(
      payload.sessionId,
      payload.runtimeId,
      openingGeneration,
    );
    let activeSession: ExecSession | null = null;
    let published = false;
    let bufferedOutputChars = 0;
    let outputOverflow = false;
    const bufferedEvents: Array<() => void> = [];
    const publishOrBuffer = (size: number, event: () => void): void => {
      if (published) {
        event();
        return;
      }
      if (
        outputOverflow
        || bufferedEvents.length >= MAX_PENDING_INPUT_CHUNKS
        || bufferedOutputChars + size > MAX_PENDING_INPUT_CHARS
      ) {
        outputOverflow = true;
        bufferedEvents.length = 0;
        bufferedOutputChars = 0;
        return;
      }
      bufferedOutputChars += size;
      bufferedEvents.push(event);
    };
    const opening = (async () => {
      let handles: ExecHandles | null = null;
      try {
        await this.assertRuntimePhysicalEnvironment();
        let openError: unknown;
        try {
          handles = await this.docker.exec(
            payload.runtimeId,
            payload.cmd,
            payload.tty,
            (data, isErr) => publishOrBuffer(data.length, () => {
              if (openingGeneration !== this.connectionGeneration) return;
              this.ws.send({
                id: uuidv4(), ts: Date.now(), kind: 'logChunk',
                payload: { sessionId: payload.sessionId, data, stderr: isErr },
              });
            }),
            (exitCode) => publishOrBuffer(0, () => {
              // Docker invokes onEnd only after its physical exit barrier. Owner
              // cleanup is identity-guarded so an old callback cannot delete a
              // replacement session with the same external ID.
              if (this.pendingExecSessions.get(payload.sessionId) === reservation) {
                this.pendingExecSessions.delete(payload.sessionId);
              }
              if (activeSession && this.execSessions.get(payload.sessionId) === activeSession) {
                this.execSessions.delete(payload.sessionId);
              }
              if (openingGeneration !== this.connectionGeneration) return;
              this.ws.send({
                id: uuidv4(), ts: Date.now(), kind: 'logChunk',
                payload: { sessionId: payload.sessionId, data: '', eof: true, exitCode },
              });
            }),
            (closeBarrier) => this.trackPhysicalExecWork(closeBarrier),
          );
        } catch (error) {
          openError = error;
        }
        if (openError || !handles) {
          // The post-sample is mandatory even when Docker rejected the open.
          await this.assertRuntimePhysicalEnvironment();
          if (openError) throw openError;
          throw new Error('Docker exec returned no session handles');
        }

        let initialResize = payload.cols && payload.rows
          ? { cols: payload.cols, rows: payload.rows }
          : undefined;
        // Controls may arrive while Docker open/resize or the daemon sample is
        // pending. Drain every pre-publication control, then sample. If another
        // control arrived during that await, repeat. The final empty check and
        // session-map publication are synchronous, so no admitted Docker RPC or
        // attach-stream write can escape the success acknowledgement.
        while (true) {
          if (
            openingGeneration !== this.connectionGeneration
            || reservation.close
            || this.pendingExecSessions.get(payload.sessionId) !== reservation
          ) {
            await this.assertRuntimePhysicalEnvironment();
            await handles.kill();
            if (this.pendingExecSessions.get(payload.sessionId) === reservation) {
              this.pendingExecSessions.delete(payload.sessionId);
            }
            if (openingGeneration === this.connectionGeneration) {
              this.ack(
                commandId,
                false,
                undefined,
                `Exec session ${payload.sessionId} was closed before opening`,
                openingGeneration,
              );
            }
            return;
          }
          if (outputOverflow) {
            await this.assertRuntimePhysicalEnvironment();
            throw new Error('Exec emitted too much output before physical identity verification');
          }

          const resize = reservation.resize ?? initialResize;
          reservation.resize = undefined;
          initialResize = undefined;
          const inputs = reservation.inputs.splice(0);
          reservation.inputChars = 0;
          let controlError: unknown;
          try {
            if (resize) await handles.resize(resize.cols, resize.rows);
            for (const input of inputs) {
              if (handles.write(input) === false) {
                throw new Error(
                  `Exec session ${payload.sessionId} exceeded stdin backpressure while opening`,
                );
              }
            }
          } catch (error) {
            controlError = error;
          }
          // Mandatory after both successful and failed Docker/control work.
          await this.assertRuntimePhysicalEnvironment();
          if (controlError) throw controlError;
          if (reservation.resize || reservation.inputs.length > 0) continue;
          break;
        }

        if (
          openingGeneration !== this.connectionGeneration
          || reservation.close
          || this.pendingExecSessions.get(payload.sessionId) !== reservation
        ) {
          await handles.kill();
          if (this.pendingExecSessions.get(payload.sessionId) === reservation) {
            this.pendingExecSessions.delete(payload.sessionId);
          }
          if (openingGeneration === this.connectionGeneration) {
            this.ack(
              commandId,
              false,
              undefined,
              `Exec session ${payload.sessionId} was closed before opening`,
              openingGeneration,
            );
          }
          return;
        }

        activeSession = {
          handles,
          generation: openingGeneration,
          runtimeId: payload.runtimeId,
          closing: null,
          controlTail: Promise.resolve(),
        };
        this.pendingExecSessions.delete(payload.sessionId);
        this.execSessions.set(payload.sessionId, activeSession);
        published = true;
        this.ack(commandId, true, { sessionId: payload.sessionId }, undefined, openingGeneration);
        for (const event of bufferedEvents) event();
        bufferedEvents.length = 0;
      } catch (error) {
        if (handles) {
          // Once a handle exists, only its physical completion callback may
          // release the owner. A non-settling kill is intentional fail-stop.
          await handles.kill();
        }
        if (this.pendingExecSessions.get(payload.sessionId) === reservation) {
          this.pendingExecSessions.delete(payload.sessionId);
        }
        if (openingGeneration !== this.connectionGeneration) return;
        const message = error instanceof Error ? error.message : String(error);
        this.ack(commandId, false, undefined, message.slice(0, 2048), openingGeneration);
      }
    })();
    reservation.opening = opening;
    this.trackPhysicalExecWork(opening);
    void opening.catch((error) => {
      // Preserve the pending/active reservation. DockerClient's production
      // contract is resolve-after-proof or fail-stop-never-resolve.
      this.physicalExecFailure ??= error;
      console.error(`[DirectRPC] Exec ${payload.sessionId} physical close failed:`, error);
    });
  }

  private async withRuntimePhysicalGuard<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertRuntimePhysicalEnvironment();
    try {
      return await operation();
    } finally {
      await this.assertRuntimePhysicalEnvironment();
    }
  }

  private enqueueActiveExecControl(
    sessionId: string,
    session: ExecSession,
    operation: () => Promise<void>,
  ): Promise<void> {
    const admitted = session.controlTail
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.assertRuntimePhysicalEnvironment();
          if (!this.isActiveExecOwner(sessionId, session)) return;

          let operationError: unknown;
          try {
            await operation();
          } catch (error) {
            operationError = error;
          }
          let postSampleError: unknown;
          try {
            await this.assertRuntimePhysicalEnvironment();
          } catch (error) {
            postSampleError = error;
          }
          if (postSampleError) throw postSampleError;
          if (operationError) throw operationError;
        } catch (error) {
          if (this.execSessions.get(sessionId) === session && session.closing === null) {
            await this.closeExecSession(sessionId, session);
          } else if (session.closing) {
            await session.closing;
          }
          throw error;
        }
      });
    session.controlTail = admitted.then(() => undefined, () => undefined);
    this.trackPhysicalExecBarrier(session.controlTail);
    return admitted;
  }

  private isActiveExecOwner(sessionId: string, session: ExecSession): boolean {
    return this.execSessions.get(sessionId) === session
      && session.generation === this.connectionGeneration
      && session.closing === null;
  }

  private pendingExec(
    sessionId: string,
    runtimeId: string,
    generation: number,
  ): PendingExecSession {
    const existing = this.pendingExecSessions.get(sessionId);
    if (existing) return existing;
    if (this.pendingExecSessions.size >= MAX_PENDING_EXEC_SESSIONS) {
      throw new Error(`Agent pending exec session limit (${MAX_PENDING_EXEC_SESSIONS}) reached`);
    }
    const created: PendingExecSession = {
      generation,
      runtimeId,
      opening: null,
      inputs: [],
      inputChars: 0,
      close: false,
    };
    this.pendingExecSessions.set(sessionId, created);
    return created;
  }

  private closeExecSession(sessionId: string, session: ExecSession): Promise<void> {
    if (session.closing) return session.closing;
    session.closing = (async () => {
      await session.handles.kill();
      if (this.execSessions.get(sessionId) === session) {
        this.execSessions.delete(sessionId);
      }
    })();
    this.trackPhysicalExecWork(session.closing);
    return session.closing;
  }

  private trackPhysicalExecWork(work: Promise<void>): void {
    this.physicalExecWork.add(work);
    void work.then(
      () => { this.physicalExecWork.delete(work); },
      (error) => {
        this.physicalExecFailure ??= error;
        // A failed physical barrier remains permanently fail-closed even
        // though the rejected Promise itself no longer needs Set retention.
        this.physicalExecWork.delete(work);
      },
    );
  }

  /** Track a bounded control even when its caller receives a clean RPC error. */
  private trackPhysicalExecBarrier(work: Promise<void>): void {
    this.physicalExecWork.add(work);
    void work.finally(() => {
      this.physicalExecWork.delete(work);
    });
  }

  private ack(
    commandId: string,
    ok: boolean,
    data?: unknown,
    error?: string,
    expectedGeneration = this.connectionGeneration,
  ): void {
    if (!commandId || expectedGeneration !== this.connectionGeneration) return;
    const payload = zCommandAckPayload.parse({
      commandId,
      ok,
      ...(data !== undefined ? { data } : {}),
      ...(error ? { error } : {}),
    });
    this.ws.send({
      id: uuidv4(),
      ts: Date.now(),
      kind: 'commandAck',
      payload,
    } as AgentToBackendMessage);
  }

  private async selfCheck(): Promise<SelfCheckResult> {
    const items: SelfCheckItem[] = [];
    try {
      await this.docker.pingDaemon();
      items.push({ id: 'docker', label: 'Docker 守护进程', status: 'ok', message: 'Docker daemon 响应正常' });
    } catch (error) {
      items.push({ id: 'docker', label: 'Docker 守护进程', status: 'fail', message: `无法连接 Docker: ${String(error)}` });
    }
    try {
      const info = await this.docker.daemonInfo();
      const root = info.DockerRootDir ?? this.config.dockerRoot;
      const { stdout } = await execFileAsync('stat', ['-f', '-c', '%T', root], { timeout: 5_000 });
      const fsType = stdout.trim();
      items.push({
        id: 'docker_data_xfs',
        label: 'Docker 数据目录 (XFS)',
        status: fsType.toLowerCase() === 'xfs' ? 'ok' : 'fail',
        message: `${root} 文件系统: ${fsType}`,
      });
    } catch (error) {
      items.push({ id: 'docker_data_xfs', label: 'Docker 数据目录 (XFS)', status: 'warn', message: `检测失败: ${String(error)}` });
    }
    for (const result of await Promise.allSettled(this.remoteFsMounter.getDriverSelfChecks())) {
      if (result.status === 'fulfilled') items.push(result.value);
    }
    items.push(...await this.dropbear.getSelfCheckItems());
    try {
      await this.quota.checkToolAvailable();
      items.push({ id: 'xfs_quota', label: 'xfs_quota', status: 'ok', message: 'xfs_quota 已安装' });
    } catch {
      items.push({ id: 'xfs_quota', label: 'xfs_quota', status: 'fail', message: 'xfs_quota 未找到' });
    }
    try {
      await execFileAsync('mkfs.xfs', ['-V'], { timeout: 3_000 });
      items.push({ id: 'xfsprogs', label: 'mkfs.xfs (xfsprogs)', status: 'ok', message: 'mkfs.xfs 已安装' });
    } catch {
      items.push({ id: 'xfsprogs', label: 'mkfs.xfs (xfsprogs)', status: 'fail', message: 'mkfs.xfs 未找到' });
    }
    return { items };
  }
}
