import Dockerode from 'dockerode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Writable } from 'stream';
import { createHash } from 'crypto';
import { AgentConfig } from '../config.js';
import { readProcMountsCached } from '../fs/proc-mounts.js';
import {
  LABEL,
  NYABASE_NETWORK,
  ContainerRuntimeObservation,
  ContainerStatsSummary,
  ImageRuntimeOverrides,
  ContainerMountSpec,
  canonicalIpv4Address,
  MAX_MANAGED_CONTAINERS_PER_AGENT,
} from '@nyabase/common';
import { Mutex } from 'async-mutex';
import { SOCKET_PATH } from './daemon-manager.js';
import { calculateDockerResourceLimitPlan, getHostResourceSnapshot } from './resource-limits.js';

const execFileAsync = promisify(execFile);

/** Thrown when a Docker API call exceeds its configured timeout. */
export class DockerTimeoutError extends Error {
  readonly ambiguous = true;

  constructor(public readonly op: string, public readonly timeoutMs: number) {
    super(`Docker operation timed out after ${timeoutMs}ms: ${op}`);
    this.name = 'DockerTimeoutError';
  }
}

/**
 * Race a generic promise against a timeout. This helper cannot cancel its
 * input; Docker HTTP reads must use `withAbortableDockerRead` below so a
 * logical timeout also destroys the physical Unix-socket request.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, op: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DockerTimeoutError(op, ms)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Bound one unary Docker observation and abort its physical HTTP request when
 * the deadline expires. dockerode forwards AbortSignal to docker-modem/Node,
 * so periodic metrics and inventory retries cannot leave wedged sockets or
 * callbacks behind after their caller has moved on.
 *
 * This helper is GET-only. A Docker POST may commit after transport abort and
 * must use runMutation/fail-stop (or an operation-specific physical barrier).
 */
export async function withAbortableDockerRead<T>(
  start: (signal: AbortSignal) => Promise<T>,
  ms: number,
  op: string,
): Promise<T> {
  const controller = new AbortController();
  const request = start(controller.signal);
  try {
    return await withTimeout(request, ms, op);
  } catch (error) {
    if (error instanceof DockerTimeoutError) controller.abort();
    throw error;
  }
}

export const DOCKER_READ_DEADLINES = {
  stats: 10_000,
  inspect: 5_000,
  list: 10_000,
  daemon: 5_000,
  eventConnect: 10_000,
} as const;
const TIMEOUT_STATS_MS = DOCKER_READ_DEADLINES.stats;
const TIMEOUT_INSPECT_MS = DOCKER_READ_DEADLINES.inspect;
const TIMEOUT_LIST_MS = DOCKER_READ_DEADLINES.list;
const MAX_DOCKER_STOP_GRACE_SECONDS = 20;
export const DEFAULT_DOCKER_MUTATION_DEADLINE_MS = 120_000;
export const DEFAULT_DOCKER_PULL_DEADLINE_MS = 30 * 60_000;
export const MANAGEMENT_EXEC_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const MAX_EXEC_STDIN_BUFFERED_BYTES = 256 * 1024;
const MANAGEMENT_EXEC_POLL_MS = 25;
const MANAGEMENT_EXEC_BARRIER_PROBE_MS = 25;
const MANAGEMENT_EXEC_FENCE_BUSY_EXIT_CODE = 75;
const MANAGEMENT_EXEC_FENCE_DIR = '/run/nyabase-management-exec.lock';
const INTERACTIVE_EXEC_TERMINATION_DEADLINE_MS = 10_000;
// 64 legal runtimes may each need an inspect/kill/fresh-inspect sequence plus
// two inventory reads. This is pre-WebSocket, so prefer a generous finite
// recovery bound over admitting work before the physical rollback is proved.
export const STATELESS_RECOVERY_QUIESCE_TIMEOUT_MS = 180_000;

export class DockerMutationDeadlineError extends Error {
  readonly ambiguous = true;

  constructor(public readonly operation: string, public readonly timeoutMs: number) {
    super(`Docker mutation exceeded its fail-stop deadline after ${timeoutMs}ms: ${operation}`);
    this.name = 'DockerMutationDeadlineError';
  }
}

/**
 * A mutation request lost its transport before Docker returned an HTTP
 * response. Its physical outcome is unknowable in this process, even though
 * dockerode's Promise has already rejected.
 */
export class DockerMutationTransportError extends Error {
  readonly ambiguous = true;

  constructor(public readonly operation: string, public readonly transportError: unknown) {
    super(`Docker mutation transport failed before an HTTP response: ${operation}`);
    this.name = 'DockerMutationTransportError';
  }
}

export class DockerObservationAmbiguityError extends Error {
  readonly ambiguous = true;

  constructor(public readonly operation: string) {
    super(`Docker observation could not prove its exec stopped: ${operation}`);
    this.name = 'DockerObservationAmbiguityError';
  }
}

export class ManagementExecOutputLimitError extends Error {
  constructor(public readonly limitBytes: number) {
    super(`Docker management exec output exceeded ${limitBytes} bytes`);
    this.name = 'ManagementExecOutputLimitError';
  }
}

export type DockerMutationFailStopError =
  | DockerMutationDeadlineError
  | DockerMutationTransportError
  | DockerObservationAmbiguityError;
type ManagementExecAmbiguityPolicy = 'stop-container' | 'fail-stop-agent';

export interface DockerClientOptions {
  mutationDeadlineMs?: number;
  pullDeadlineMs?: number;
  /** Production sends SIGKILL; tests inject a recorder that deliberately returns. */
  fatalHook?: (error: DockerMutationFailStopError) => void;
}

function killAgentAfterAmbiguousMutation(error: DockerMutationFailStopError): void {
  console.error(`[Docker] ${error.message}; terminating Agent to prevent overlapping replay`);
  process.kill(process.pid, 'SIGKILL');
}

function hasDockerHttpStatusCode(error: unknown): error is { statusCode: number } {
  if ((typeof error !== 'object' || error === null) && typeof error !== 'function') return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return Number.isInteger(statusCode) && (statusCode as number) >= 100 && (statusCode as number) <= 599;
}

export interface ContainerRuntimeSpec {
  /** Durable Backend desired-spec generation for this immutable runtime. */
  specGeneration: number;
  name: string;
  imageRef: string;
  cpuMillis: number;
  memBytes: number;
  gpuIndices: number[];
  ip: string;
  containerId: string;
  ownerId: string;
  imageId: string;
  runtimeOverrides: ImageRuntimeOverrides;
  serverId: string;
  /** Immutable Docker-native bind set. Changing it requires replacing the runtime. */
  mounts: ResolvedContainerMountSpec[];
}

/** Agent-resolved physical mount. hostPath is never accepted from Backend. */
export interface ResolvedContainerMountSpec extends ContainerMountSpec {
  hostPath: string;
}

/**
 * Stable hash of every immutable value used to create a Docker runtime.
 * The dynamically allocated IP is included after allocation and can be read
 * back from an existing runtime before validating its label on recovery.
 */
export function hashContainerRuntimeSpec(spec: ContainerRuntimeSpec, cgroupParent: string | null = null): string {
  return createHash('sha256').update(stableJson({
    ...spec,
    gpuIndices: [...spec.gpuIndices].sort((left, right) => left - right),
    cgroupParent,
  })).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

export class DockerClient {
  private readonly docker: Dockerode;
  /**
   * Serialize management execs per live runtime without retaining every
   * runtime identity ever observed. `users` covers both the lock holder and
   * queued callers, so the entry can be removed exactly when the last caller
   * settles without racing a newly queued caller.
   */
  private readonly managementExecMutexes = new Map<string, { mutex: Mutex; users: number }>();
  private readonly mutationDeadlineMs: number;
  private readonly pullDeadlineMs: number;
  private readonly fatalHook: (error: DockerMutationFailStopError) => void;
  private failStopTriggered = false;

  constructor(private config: AgentConfig, options: DockerClientOptions = {}) {
    this.docker = new Dockerode({ socketPath: SOCKET_PATH });
    this.mutationDeadlineMs = Number.isSafeInteger(options.mutationDeadlineMs)
      && (options.mutationDeadlineMs ?? 0) > 0
      ? options.mutationDeadlineMs!
      : DEFAULT_DOCKER_MUTATION_DEADLINE_MS;
    this.pullDeadlineMs = Number.isSafeInteger(options.pullDeadlineMs)
      && (options.pullDeadlineMs ?? 0) > 0
      ? options.pullDeadlineMs!
      : DEFAULT_DOCKER_PULL_DEADLINE_MS;
    this.fatalHook = options.fatalHook ?? killAgentAfterAmbiguousMutation;
  }

  async ensureMacvlanNetwork(): Promise<void> {
    const existing = await this.inspectManagedNetwork();
    if (existing) {
      this.assertManagedNetwork(existing);
      return;
    }

    console.log(`[Docker] Creating macvlan network ${NYABASE_NETWORK}`);
    let createError: unknown = null;
    try {
      await this.runMutation(`network.create(${NYABASE_NETWORK})`, () => this.docker.createNetwork({
        Name: NYABASE_NETWORK,
        Driver: 'macvlan',
        Options: { parent: this.config.parentIface },
        IPAM: {
          Config: [
            {
              Subnet: this.config.macvlanCidr,
              Gateway: this.config.macvlanGateway,
            },
          ],
        },
      }));
    } catch (error) {
      createError = error;
    }

    // An explicit Docker error may race an earlier idempotent attempt or an
    // already-existing network. Only a fresh exact inspect may turn that
    // settled response into ensure success. Transport loss never reaches here.
    const observed = await this.inspectManagedNetwork();
    if (!observed) {
      if (createError) throw createError;
      throw new Error(`Docker network ${NYABASE_NETWORK} is absent after create`);
    }
    this.assertManagedNetwork(observed);
  }

  private async inspectManagedNetwork(): Promise<Dockerode.NetworkInspectInfo | null> {
    const candidates = await withAbortableDockerRead(
      (signal) => this.docker.listNetworks({
        filters: { name: [NYABASE_NETWORK] },
        abortSignal: signal,
      }),
      TIMEOUT_LIST_MS,
      `network.list(${NYABASE_NETWORK})`,
    );
    const exact = candidates.filter((network) => network.Name === NYABASE_NETWORK);
    if (exact.length === 0) return null;
    if (exact.length !== 1 || !exact[0].Id) {
      throw new Error(`Docker network identity is ambiguous for ${NYABASE_NETWORK}`);
    }
    const network = this.docker.getNetwork(exact[0].Id);
    return withAbortableDockerRead(
      (signal) => (network.inspect as unknown as (
        options: { abortSignal: AbortSignal },
      ) => Promise<Dockerode.NetworkInspectInfo>)({ abortSignal: signal }),
      TIMEOUT_INSPECT_MS,
      `network.inspect(${NYABASE_NETWORK})`,
    );
  }

  private assertManagedNetwork(network: Dockerode.NetworkInspectInfo): void {
    const ipam = network.IPAM?.Config ?? [];
    const exactIpam = ipam.length === 1
      && ipam[0].Subnet === this.config.macvlanCidr
      && ipam[0].Gateway === this.config.macvlanGateway;
    if (
      network.Name !== NYABASE_NETWORK
      || network.Driver !== 'macvlan'
      || network.Options?.parent !== this.config.parentIface
      || !exactIpam
    ) {
      throw new Error(
        `Docker network ${NYABASE_NETWORK} does not match configured macvlan identity: `
        + JSON.stringify({
          expected: {
            driver: 'macvlan',
            parent: this.config.parentIface,
            subnet: this.config.macvlanCidr,
            gateway: this.config.macvlanGateway,
          },
          observed: {
            name: network.Name,
            driver: network.Driver,
            parent: network.Options?.parent ?? null,
            ipam,
          },
        }),
      );
    }
  }

  async listNyabaseContainers(): Promise<Dockerode.ContainerInfo[]> {
    return withAbortableDockerRead(
      (signal) => this.docker.listContainers({
        all: true,
        filters: { label: [`${LABEL.MANAGED}=true`] },
        abortSignal: signal,
      }),
      TIMEOUT_LIST_MS,
      'listContainers(v2-managed)',
    );
  }

  /**
   * A fresh Agent process deliberately owns no durable exec/session state. Its
   * startup proof must therefore make every process that could have belonged
   * to the previous process physically absent before accepting Backend work.
   *
   * The dedicated dockerd has already passed the startup mutation fence and
   * no new task/direct work is admitted while this method runs. Two bounded
   * inventory passes cover containers recovered while dockerd itself was
   * starting; every returned runtime is stopped by exact Docker ID and then
   * freshly observed stopped/absent. Backend desired state may start it again
   * later through an ordinary durable task.
   */
  async quiesceManagedContainersForStatelessRecovery(
    timeoutMs = STATELESS_RECOVERY_QUIESCE_TIMEOUT_MS,
  ): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid stateless recovery quiesce timeout: ${String(timeoutMs)}`);
    }
    const deadlineAt = Date.now() + timeoutMs;

    for (let pass = 0; pass < 2; pass += 1) {
      if (Date.now() >= deadlineAt) {
        throw new DockerTimeoutError('stateless managed-container recovery', timeoutMs);
      }
      const inventory = await this.listNyabaseContainers();
      if (inventory.length > MAX_MANAGED_CONTAINERS_PER_AGENT) {
        throw new Error(
          `Managed container inventory exceeds ${MAX_MANAGED_CONTAINERS_PER_AGENT}; `
          + 'refusing an unbounded stateless recovery scan',
        );
      }

      const runtimeIds = new Set<string>();
      for (const container of inventory) {
        if (typeof container.Id !== 'string' || !/^[a-f0-9]{64}$/.test(container.Id)) {
          throw new Error('Managed container inventory contains an invalid exact Docker ID');
        }
        runtimeIds.add(container.Id);
      }
      for (const runtimeId of runtimeIds) {
        await this.stopExactContainerForExecBarrier(runtimeId, deadlineAt);
      }
    }
  }

  async listAllContainers(): Promise<Dockerode.ContainerInfo[]> {
    return withAbortableDockerRead(
      (signal) => this.docker.listContainers({ all: true, abortSignal: signal }),
      TIMEOUT_LIST_MS,
      'listContainers(all)',
    );
  }

  async inspectContainer(dockerId: string): Promise<Dockerode.ContainerInspectInfo> {
    return withAbortableDockerRead(
      (signal) => this.docker.getContainer(dockerId).inspect({ abortSignal: signal }),
      TIMEOUT_INSPECT_MS,
      `inspect(${dockerId.slice(0, 12)})`,
    );
  }

  async inspectImage(reference: string): Promise<Dockerode.ImageInspectInfo> {
    const image = this.docker.getImage(reference);
    return withAbortableDockerRead(
      (signal) => (image.inspect as unknown as (
        options: { abortSignal: AbortSignal },
      ) => Promise<Dockerode.ImageInspectInfo>)({ abortSignal: signal }),
      DOCKER_READ_DEADLINES.inspect,
      `image.inspect(${reference})`,
    );
  }

  async listImages(): Promise<Dockerode.ImageInfo[]> {
    return withAbortableDockerRead(
      (signal) => this.docker.listImages({ all: false, abortSignal: signal }),
      DOCKER_READ_DEADLINES.list,
      'image.list',
    );
  }

  async removeImage(reference: string): Promise<void> {
    await this.runMutation(
      `image.remove(${reference})`,
      () => this.docker.getImage(reference).remove({ force: false }),
    );
  }

  async pingDaemon(): Promise<void> {
    await withAbortableDockerRead(
      (signal) => (this.docker.ping as unknown as (
        options: { abortSignal: AbortSignal },
      ) => Promise<void>)({ abortSignal: signal }),
      DOCKER_READ_DEADLINES.daemon,
      'daemon.ping',
    );
  }

  async daemonInfo(): Promise<{ DockerRootDir?: string }> {
    return withAbortableDockerRead(
      (signal) => (this.docker.info as unknown as (
        options: { abortSignal: AbortSignal },
      ) => Promise<{ DockerRootDir?: string }>)({ abortSignal: signal }),
      DOCKER_READ_DEADLINES.daemon,
      'daemon.info',
    );
  }

  async openContainerEventStream(): Promise<NodeJS.ReadableStream> {
    const controller = new AbortController();
    const opening = this.docker.getEvents({
      filters: { type: ['container'] },
      abortSignal: controller.signal,
    });
    try {
      return await withTimeout(
        opening,
        DOCKER_READ_DEADLINES.eventConnect,
        'events.connect(container)',
      );
    } catch (error) {
      if (error instanceof DockerTimeoutError) {
        controller.abort();
        // getEvents can deliver a stream after our caller has already moved to
        // a newer connection generation. A late stream must not leak.
        void opening.then((lateStream) => {
          try { (lateStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); } catch { /* closed */ }
        }, () => {});
      }
      throw error;
    }
  }

  async createContainer(params: ContainerRuntimeSpec): Promise<string> {
    const cgroupParent = this.runtimeCgroupParent();
    const runtimeSpecHash = hashContainerRuntimeSpec(params, cgroupParent);
    const labels: Record<string, string> = {
      [LABEL.MANAGED]: 'true',
      [LABEL.CONTAINER_ID]: params.containerId,
      [LABEL.SERVER_ID]: params.serverId,
      [LABEL.SPEC_GENERATION]: String(params.specGeneration),
      [LABEL.RUNTIME_SPEC_HASH]: runtimeSpecHash,
    };

    const env: string[] = [];
    if (params.gpuIndices.length > 0) {
      env.push(`NVIDIA_VISIBLE_DEVICES=${params.gpuIndices.join(',')}`);
      env.push('NVIDIA_DRIVER_CAPABILITIES=all');
    }
    const deviceRequests: Dockerode.DeviceRequest[] = params.gpuIndices.length > 0
      ? [{
          Driver: 'nvidia',
          DeviceIDs: params.gpuIndices.map(String),
          Capabilities: [['gpu']],
        }]
      : [];
    const createOptions: Dockerode.ContainerCreateOptions = {
      name: this.runtimeName(params.containerId),
      Image: params.imageRef,
      User: String(params.runtimeOverrides.uid),
      Entrypoint: params.runtimeOverrides.entrypoint ?? undefined,
      Cmd: params.runtimeOverrides.cmd ?? undefined,
      Labels: labels,
      Env: env,
      HostConfig: {
        NanoCpus: params.cpuMillis > 0 ? params.cpuMillis * 1_000_000 : 0,
        Memory: params.memBytes > 0 ? params.memBytes : 0,
        MemorySwap: params.memBytes > 0 ? params.memBytes : 0,
        Init: params.runtimeOverrides.init,
        Runtime: params.gpuIndices.length > 0 ? 'nvidia' : undefined,
        CgroupParent: cgroupParent ?? undefined,
        ...(deviceRequests.length > 0 && { DeviceRequests: deviceRequests }),
        NetworkMode: NYABASE_NETWORK,
        RestartPolicy: { Name: 'no' },
        Mounts: params.mounts.map((mount) => ({
          Type: 'bind' as const,
          Source: mount.hostPath,
          Target: mount.containerPath,
          ReadOnly: false,
          BindOptions: { Propagation: 'rprivate' as const },
        })),
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [NYABASE_NETWORK]: {
            IPAMConfig: { IPv4Address: params.ip },
          },
        },
      },
    };
    try {
      // Never race a non-cancellable Docker mutation against a logical timer:
      // returning early would allow Backend replay to overlap this request.
      const container = await this.runMutation(
        `container.create(${params.containerId})`,
        () => this.docker.createContainer(createOptions),
      );
      return container.id;
    } catch (error) {
      // A settled Docker error may still find the immutable runtime left by an
      // earlier idempotent attempt. Transport loss never reaches this catch;
      // it fail-stops inside runMutation and leaves the call pending.
      const matches = (await this.listNyabaseContainers()).filter((container) => (
        container.Labels?.[LABEL.CONTAINER_ID] === params.containerId
        && container.Labels?.[LABEL.SERVER_ID] === params.serverId
      ));
      if (matches.length === 1) {
        if (!matches[0].Id) throw new Error(`Container create probe returned an empty runtime id for ${params.containerId}`);
        if (
          matches[0].Labels?.[LABEL.SPEC_GENERATION] !== String(params.specGeneration)
          || matches[0].Labels?.[LABEL.RUNTIME_SPEC_HASH] !== runtimeSpecHash
        ) {
          throw new Error(`Container create probe found a runtime with mismatched immutable generation/spec for ${params.containerId}`);
        }
        return matches[0].Id;
      }
      if (matches.length > 1) {
        throw new Error(`Container create failed and ${matches.length} runtimes claim ${params.containerId}`);
      }
      throw error;
    }
  }

  runtimeSpecHash(params: ContainerRuntimeSpec): string {
    return hashContainerRuntimeSpec(params, this.runtimeCgroupParent());
  }

  private runtimeCgroupParent(): string | null {
    return calculateDockerResourceLimitPlan(
      this.config.dockerResourceLimit,
      getHostResourceSnapshot(),
    ).cgroupParent;
  }

  private runtimeName(containerId: string): string {
    return `nyabase-${createHash('sha256').update(containerId).digest('hex')}`;
  }

  async startContainer(dockerId: string): Promise<void> {
    try {
      await this.runMutation(
        `container.start(${dockerId.slice(0, 12)})`,
        () => this.docker.getContainer(dockerId).start(),
      );
    } catch (err) {
      // 304: container already started — treat as success
      if ((err as { statusCode?: number }).statusCode === 304) return;
      throw err;
    }
  }

  async stopContainer(dockerId: string, timeoutSeconds = 10): Promise<void> {
    try {
      await this.runMutation(
        `container.stop(${dockerId.slice(0, 12)})`,
        () => this.docker.getContainer(dockerId).stop({
          t: Math.max(0, Math.min(timeoutSeconds, MAX_DOCKER_STOP_GRACE_SECONDS)),
        }),
      );
    } catch (err) {
      // 304: container already stopped — treat as success
      if ((err as { statusCode?: number }).statusCode === 304) return;
      throw err;
    }
  }

  async restartContainer(dockerId: string, timeoutSeconds = 10): Promise<void> {
    await this.runMutation(
      `container.restart(${dockerId.slice(0, 12)})`,
      () => this.docker.getContainer(dockerId).restart({
        t: Math.max(0, Math.min(timeoutSeconds, MAX_DOCKER_STOP_GRACE_SECONDS)),
      }),
    );
  }

  async removeContainer(dockerId: string, force = false): Promise<void> {
    try {
      await this.runMutation(
        `container.remove(${dockerId.slice(0, 12)})`,
        () => this.docker.getContainer(dockerId).remove({ force, v: false }),
      );
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return;
      throw err;
    }
  }

  async exec(
    dockerId: string,
    cmd: string[],
    tty: boolean,
    onData: (data: string, isErr: boolean) => void,
    onEnd: (exitCode: number) => void,
    onClosing?: (completion: Promise<void>) => void,
  ): Promise<{
    resize: (cols: number, rows: number) => Promise<void>;
    kill: () => Promise<void>;
    write: (data: string) => boolean;
  }> {
    const exec = await this.runMutation(
      `exec.create(${dockerId.slice(0, 12)})`,
      () => this.docker.getContainer(dockerId).exec({
        Cmd: cmd,
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: tty,
      }),
    );

    let stream: Awaited<ReturnType<Dockerode.Exec['start']>>;
    try {
      stream = await this.runMutation(
        `exec.start(${dockerId.slice(0, 12)})`,
        () => exec.start({ hijack: true, stdin: true, Tty: tty }),
      );
    } catch (error) {
      // Even an HTTP 5xx from exec.start is not negative proof that Docker did
      // not launch the process. Do not reject to DirectRPC until the created
      // exec has crossed the same physical absence barrier as a claimed one.
      await this.completeInteractiveExecFailClosed(exec, dockerId);
      throw error;
    }

    let controlsClosed = false;
    let endNotified = false;
    let completion: Promise<void> | null = null;
    type PendingResize = {
      cols: number;
      rows: number;
      waiters: Array<{
        resolve: () => void;
        reject: (error: unknown) => void;
      }>;
    };
    let pendingResize: PendingResize | null = null;
    let resizeInFlight: Promise<void> | null = null;
    const startResizeDrain = () => {
      if (resizeInFlight || controlsClosed || !pendingResize) return;
      const drain = async () => {
        while (!controlsClosed && pendingResize) {
          const next = pendingResize;
          pendingResize = null;
          try {
            await this.runMutation(
              `exec.resize(${dockerId.slice(0, 12)})`,
              () => exec.resize({ w: next.cols, h: next.rows }),
            );
            for (const waiter of next.waiters) waiter.resolve();
          } catch (error) {
            // Every admitted caller owns an exact completion result. A newer
            // coalesced resize may still run, but this batch must not be
            // reported complete after Docker rejected it.
            for (const waiter of next.waiters) waiter.reject(error);
          }
        }
      };
      const active = drain().finally(() => {
        if (resizeInFlight === active) resizeInFlight = null;
        if (!controlsClosed && pendingResize) startResizeDrain();
      });
      resizeInFlight = active;
    };
    const finish = (): Promise<void> => {
      controlsClosed = true;
      const abandonedResize = pendingResize;
      pendingResize = null;
      if (abandonedResize) {
        const error = new Error(`Interactive exec ${dockerId} closed before resize completed`);
        for (const waiter of abandonedResize.waiters) waiter.reject(error);
      }
      if (completion) return completion;
      completion = (async () => {
        const exitCode = await this.completeInteractiveExecFailClosed(exec, dockerId);
        // A resize POST admitted before close can otherwise time out and
        // fail-stop the Agent after a newer task has already succeeded. The
        // close owner stays reserved until that earlier mutation settles (or
        // its own fail-stop fires and deliberately never resolves).
        const resizeBarrier = resizeInFlight;
        if (resizeBarrier) await resizeBarrier;
        // Destroying the hijacked stream is cleanup, never the physical exit
        // barrier. completeInteractiveExec has already proved that the exact
        // exec stopped (or stopped and re-observed its exact container).
        try { stream.destroy(); } catch { /* already closed */ }
        if (endNotified) return;
        endNotified = true;
        try {
          onEnd(exitCode);
        } catch (error) {
          console.error('[Docker] Interactive exec completion callback failed:', error);
        }
      })();
      try {
        onClosing?.(completion);
      } catch (error) {
        this.triggerMutationFailStop(new DockerObservationAmbiguityError(
          `interactive exec close tracking(${dockerId.slice(0, 12)}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        ));
        return new Promise<never>(() => { /* production is terminating */ });
      }
      return completion;
    };

    let handlersReady = false;
    const finishFromStream = () => {
      if (handlersReady) void finish();
    };
    const forwardData = (data: Buffer, isErr: boolean) => {
      try {
        onData(data.toString('base64'), isErr);
      } catch {
        void finish();
      }
    };
    try {
      if (!tty) {
        // demuxStream needs Writable-like objects; cast to satisfy dockerode.
        const stdout = { write: (data: Buffer) => forwardData(data, false) } as unknown as NodeJS.WritableStream;
        const stderr = { write: (data: Buffer) => forwardData(data, true) } as unknown as NodeJS.WritableStream;
        this.docker.modem.demuxStream(stream, stdout, stderr);
      } else {
        stream.on('data', (data: Buffer) => forwardData(data, false));
      }
      stream.on('end', finishFromStream);
      stream.on('close', finishFromStream);
      stream.on('error', finishFromStream);
      handlersReady = true;
      if (stream.readableEnded || stream.destroyed) void finish();
    } catch (error) {
      // A synchronous attach/demux setup failure happens before a handle can
      // be returned. It still owns the created exec until physical cleanup.
      await this.completeInteractiveExecFailClosed(exec, dockerId);
      try { stream.destroy(); } catch { /* already closed */ }
      throw error;
    }

    return {
      resize: (cols, rows) => {
        if (controlsClosed) {
          return Promise.reject(new Error(`Interactive exec ${dockerId} is closing`));
        }
        const completion = new Promise<void>((resolve, reject) => {
          if (pendingResize) {
            pendingResize.cols = cols;
            pendingResize.rows = rows;
            pendingResize.waiters.push({ resolve, reject });
          } else {
            pendingResize = { cols, rows, waiters: [{ resolve, reject }] };
          }
          startResizeDrain();
        });
        return completion;
      },
      // Closing the hijacked stream alone does not signal the in-container
      // process. Every caller must await the shared physical completion
      // barrier before it is allowed to forget the session owner.
      kill: finish,
      write: (data: string) => {
        if (
          controlsClosed
          || !stream.writable
          || stream.destroyed
          || stream.writableNeedDrain
        ) return false;
        const decoded = Buffer.from(data, 'base64');
        if (
          decoded.length > MAX_EXEC_STDIN_BUFFERED_BYTES
          || stream.writableLength > MAX_EXEC_STDIN_BUFFERED_BYTES - decoded.length
        ) return false;
        return stream.write(decoded);
      },
    };
  }

  /**
   * Run an Agent-owned management command as container uid 0.
   *
   * This is deliberately separate from exec(), which must inherit the image's
   * configured user for interactive/user commands.  Agent control-plane code
   * must opt in explicitly when it needs to maintain root-owned files.
   */
  async execManagementCapture(
    dockerId: string,
    cmd: string[],
    timeoutMs = 10_000,
    stdin?: Buffer,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.execCaptureWithPolicy(
      dockerId,
      cmd,
      timeoutMs,
      stdin,
      'stop-container',
    );
  }

  /**
   * Run a bounded read-only helper without ever changing container power.
   * If Docker cannot prove that the helper stopped, the Agent fail-stops and
   * leaves Backend's last authoritative runtime state unchanged.
   */
  async execObservationCapture(
    dockerId: string,
    cmd: string[],
    timeoutMs = 10_000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.execCaptureWithPolicy(
      dockerId,
      cmd,
      timeoutMs,
      undefined,
      'fail-stop-agent',
    );
  }

  private async execCaptureWithPolicy(
    dockerId: string,
    cmd: string[],
    timeoutMs: number,
    stdin: Buffer | undefined,
    ambiguityPolicy: ManagementExecAmbiguityPolicy,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid management exec timeout: ${timeoutMs}`);
    }
    let entry = this.managementExecMutexes.get(dockerId);
    if (!entry) {
      entry = { mutex: new Mutex(), users: 0 };
      this.managementExecMutexes.set(dockerId, entry);
    }
    entry.users += 1;
    try {
      return await entry.mutex.runExclusive(
        () => this.execManagementCaptureInternal(
          dockerId,
          cmd,
          timeoutMs,
          stdin,
          ambiguityPolicy,
        ),
      );
    } finally {
      entry.users -= 1;
      if (entry.users === 0 && this.managementExecMutexes.get(dockerId) === entry) {
        this.managementExecMutexes.delete(dockerId);
      }
    }
  }

  /** Copy an Agent-owned file through an explicit uid-0 management exec. */
  async putManagementFile(
    dockerId: string,
    containerPath: string,
    data: Buffer,
    mode = 0o644,
  ): Promise<void> {
    if (!containerPath.startsWith('/') || containerPath.includes('\0')) {
      throw new Error('Management file destination must be an absolute container path');
    }
    if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error(`Invalid management file mode: ${mode}`);
    }
    const result = await this.execManagementCapture(
      dockerId,
      [
        '/bin/sh',
        '-c',
        'umask 077; cat > "$1" && chmod "$2" "$1"',
        'nyabase-management-copy',
        containerPath,
        mode.toString(8),
      ],
      this.mutationDeadlineMs,
      data,
    );
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim()
        || result.stdout.trim()
        || `management file copy exited ${result.exitCode}`,
      );
    }
  }

  private async execManagementCaptureInternal(
    dockerId: string,
    cmd: string[],
    timeoutMs: number,
    stdin?: Buffer,
    ambiguityPolicy: ManagementExecAmbiguityPolicy = 'stop-container',
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const attachStdin = stdin !== undefined;
    const deadlineAt = Date.now() + timeoutMs;
    // Reserve part of the caller's total deadline for the physical stop
    // barrier. Returning a timeout while the exec can still mutate the
    // container would allow a replay to overlap it after an Agent restart.
    const barrierReserveMs = Math.min(5_000, Math.max(10, Math.floor(timeoutMs / 4)));
    const workDeadlineAt = Math.max(Date.now() + 1, deadlineAt - barrierReserveMs);
    const remainingWorkMs = () => Math.max(1, workDeadlineAt - Date.now());
    const exec = await this.runMutation(
      `exec.create(${dockerId.slice(0, 12)})`,
      () => this.docker.getContainer(dockerId).exec({
        Cmd: this.managementExecFenceCommand(cmd),
        AttachStdin: attachStdin,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        User: '0',
      }),
      remainingWorkMs(),
    );

    let stream: Awaited<ReturnType<typeof exec.start>>;
    try {
      stream = await this.runMutation(
        `exec.start(${dockerId.slice(0, 12)})`,
        () => exec.start({
          Tty: false,
          ...(attachStdin ? { hijack: true, stdin: true } : {}),
        }),
        remainingWorkMs(),
      );
    } catch (error) {
      await this.ensureManagementExecStopped(exec, dockerId, deadlineAt, ambiguityPolicy);
      throw error;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;
    let outputError: ManagementExecOutputLimitError | null = null;
    const capture = (chunks: Buffer[], value: Buffer): void => {
      if (outputError) return;
      const chunk = Buffer.from(value);
      const remaining = MANAGEMENT_EXEC_OUTPUT_LIMIT_BYTES - capturedBytes;
      if (remaining > 0) {
        const accepted = chunk.subarray(0, remaining);
        chunks.push(accepted);
        capturedBytes += accepted.length;
      }
      if (chunk.length > remaining) {
        outputError = new ManagementExecOutputLimitError(MANAGEMENT_EXEC_OUTPUT_LIMIT_BYTES);
        try { stream.destroy(outputError); } catch { /* completion barrier below still decides safety */ }
      }
    };
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        capture(stdoutChunks, chunk);
        callback();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        capture(stderrChunks, chunk);
        callback();
      },
    });

    let streamSettled = false;
    let streamError: unknown = null;
    const settleStream = () => { streamSettled = true; };
    stream.once('end', settleStream);
    stream.once('close', settleStream);
    stream.once('error', (error) => {
      streamError = error;
      streamSettled = true;
    });

    try {
      this.docker.modem.demuxStream(stream, stdout, stderr);
      if (attachStdin) {
        (stream as NodeJS.ReadWriteStream).end(stdin);
      }
      const exitCode = await this.waitForManagementExecCompletion(
        exec,
        dockerId,
        cmd[0] ?? '',
        workDeadlineAt,
        () => ({ streamSettled, streamError, outputError }),
      );
      return {
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode,
      };
    } catch (error) {
      try { stream.destroy(); } catch { /* already closed */ }
      await this.ensureManagementExecStopped(exec, dockerId, deadlineAt, ambiguityPolicy);
      throw error;
    }
  }

  /**
   * Every management exec takes a container-resident boot-epoch fence. If an
   * Agent is SIGKILLed, the still-running wrapper retains the fence and a new
   * Agent cannot overlap it. A dead owner in the same container boot remains
   * fail-closed; only a container stop/start changes the boot-scoped fence
   * path, after every old in-container process has necessarily exited.
   */
  private managementExecFenceCommand(cmd: readonly string[]): string[] {
    const lockBase = `'${MANAGEMENT_EXEC_FENCE_DIR}'`;
    const busy = MANAGEMENT_EXEC_FENCE_BUSY_EXIT_CODE;
    const script = [
      `lock_base=${lockBase}`,
      `busy=${busy}`,
      `self_pid=$$`,
      `self_started="$(awk '{print $22}' /proc/$$/stat 2>/dev/null || true)"`,
      `boot_started="$(awk '{print $22}' /proc/1/stat 2>/dev/null || true)"`,
      `[ -n "$self_started" ] && [ -n "$boot_started" ] || exit "$busy"`,
      `case "$self_pid:$self_started:$boot_started" in *[!0-9:]*) exit "$busy";; esac`,
      `lock="${'$'}{lock_base}.${'$'}{boot_started}"`,
      `mkdir "$lock" 2>/dev/null || exit "$busy"`,
      `umask 077`,
      `if ! printf '%s %s %s\n' "$self_pid" "$self_started" "$boot_started" > "$lock/owner"; then`,
      `  rmdir "$lock" 2>/dev/null || true`,
      `  exit "$busy"`,
      `fi`,
      `cleanup() {`,
      `  current="$(cat "$lock/owner" 2>/dev/null || true)"`,
      `  [ "$current" = "$self_pid $self_started $boot_started" ] || return 0`,
      `  rm -f "$lock/owner"`,
      `  rmdir "$lock" 2>/dev/null || true`,
      `}`,
      `trap cleanup EXIT`,
      `"$@"`,
    ].join('\n');
    return ['/bin/sh', '-c', script, 'nyabase-management-exec', ...cmd];
  }

  private async waitForManagementExecCompletion(
    exec: Dockerode.Exec,
    dockerId: string,
    executable: string,
    deadlineAt: number,
    state: () => {
      streamSettled: boolean;
      streamError: unknown;
      outputError: ManagementExecOutputLimitError | null;
    },
  ): Promise<number> {
    const operation = `exec.complete(${dockerId.slice(0, 12)}:${executable})`;
    for (;;) {
      const current = state();
      if (current.outputError) throw current.outputError;
      if (current.streamError) throw current.streamError;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw new DockerTimeoutError(operation, 0);
      const info = await withAbortableDockerRead(
        (signal) => exec.inspect({ abortSignal: signal }),
        Math.max(1, Math.min(TIMEOUT_INSPECT_MS, remaining)),
        `${operation}.inspect`,
      );
      if (
        info.Running === false
        && Number.isSafeInteger(info.ExitCode)
        && current.streamSettled
      ) {
        return info.ExitCode!;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(MANAGEMENT_EXEC_POLL_MS, Math.max(1, remaining)));
      });
    }
  }

  private async ensureManagementExecStopped(
    exec: Dockerode.Exec,
    dockerId: string,
    deadlineAt: number,
    ambiguityPolicy: ManagementExecAmbiguityPolicy,
  ): Promise<void> {
    const remaining = deadlineAt - Date.now();
    if (remaining > 0) {
      try {
        const info = await withAbortableDockerRead(
          (signal) => exec.inspect({ abortSignal: signal }),
          Math.max(1, Math.min(MANAGEMENT_EXEC_BARRIER_PROBE_MS, remaining)),
          `exec.abort.inspect(${dockerId.slice(0, 12)})`,
        );
        if (info.Running === false) return;
      } catch { /* unknown means the container itself must become the barrier */ }
    }
    if (ambiguityPolicy === 'stop-container') {
      await this.stopExactContainerForExecBarrier(dockerId, deadlineAt);
      return;
    }
    this.triggerMutationFailStop(new DockerObservationAmbiguityError(
      `management exec observation barrier(${dockerId.slice(0, 12)})`,
    ));
    await new Promise<never>(() => { /* production is terminating */ });
  }

  private async stopExactContainerForExecBarrier(
    dockerId: string,
    deadlineAt: number,
  ): Promise<void> {
    const container = this.docker.getContainer(dockerId);
    let lastError: unknown = null;
    while (Date.now() < deadlineAt) {
      const remaining = Math.max(1, deadlineAt - Date.now());
      try {
        const info = await withAbortableDockerRead(
          (signal) => container.inspect({ abortSignal: signal }),
          Math.min(MANAGEMENT_EXEC_BARRIER_PROBE_MS, remaining),
          `container.exec-barrier.inspect(${dockerId.slice(0, 12)})`,
        );
        if (info.State.Running === false) return;
        if (info.State.Paused === true) {
          try {
            await this.runMutation(
              `container.exec-barrier.unpause(${dockerId.slice(0, 12)})`,
              () => container.unpause(),
              Math.min(1_000, Math.max(1, deadlineAt - Date.now())),
            );
          } catch (error) {
            // A definite Docker error may race a state change. The following
            // kill plus fresh inspect remains the only success proof.
            lastError = error;
          }
        }
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode === 404) return;
        lastError = error;
      }

      try {
        await this.runMutation(
          `container.exec-barrier.kill(${dockerId.slice(0, 12)})`,
          () => container.kill({ signal: 'SIGKILL' }),
          Math.min(1_000, Math.max(1, deadlineAt - Date.now())),
        );
      } catch (error) {
        // A lost kill response is still ambiguous. Fresh stopped observation,
        // not the response, is the only completion barrier.
        lastError = error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(MANAGEMENT_EXEC_POLL_MS, Math.max(1, deadlineAt - Date.now())));
      });
    }

    const error = new DockerMutationDeadlineError(
      `exact container physical stop barrier(${dockerId.slice(0, 12)}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      0,
    );
    this.triggerMutationFailStop(error);
    await new Promise<never>(() => { /* production is terminating; never permit replay */ });
  }

  async getGraphDriverDirs(
    dockerId: string,
    inspected?: Dockerode.ContainerInspectInfo,
  ): Promise<{ upperDir: string; workDir: string }> {
    const info = inspected ?? await this.inspectContainer(dockerId);
    const data = info.GraphDriver?.Data as Record<string, string> | undefined;

    // overlay2 driver (older Docker): UpperDir/WorkDir available in GraphDriver.Data
    if (data?.UpperDir) {
      return { upperDir: data.UpperDir, workDir: data.WorkDir ?? '' };
    }

    // Docker 29+ overlayfs driver (containerd snapshotter)
    // Strategy 1: parse /proc/mounts (works only while container is running)
    const possibleMountpoints = [
      `/var/lib/docker/rootfs/overlayfs/${dockerId}`,
      `${this.config.dockerRoot}/rootfs/overlayfs/${dockerId}`,
    ];
    try {
      const mounts = await readProcMountsCached();
      for (const line of mounts.split('\n')) {
        if (!line.includes('overlay ')) continue;
        const parts = line.split(' ');
        const mountPoint = parts[1];
        if (!possibleMountpoints.some((p) => mountPoint === p)) continue;
        const opts = parts[3] ?? '';
        const upperDir = opts.match(/upperdir=([^,\s]+)/)?.[1] ?? '';
        const workDir = opts.match(/workdir=([^,\s]+)/)?.[1] ?? '';
        if (upperDir) return { upperDir, workDir };
      }
    } catch {
      // /proc/mounts unavailable or container not running, fall through
    }

    // Strategy 2: use containerd CLI (ctr) to query snapshot mount info
    // Works even for stopped/exited containers as the snapshot persists
    try {
      const { stdout } = await execFileAsync(
        'ctr',
        ['-n', 'moby', 'snapshots', 'mounts', '/dev/null', dockerId],
        { timeout: TIMEOUT_INSPECT_MS, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      );
      const upperDir = stdout.match(/upperdir=([^,\s]+)/)?.[1] ?? '';
      const workDir = stdout.match(/workdir=([^,\s]+)/)?.[1] ?? '';
      if (upperDir) return { upperDir, workDir };
    } catch {
      // ctr not available or snapshot not found
    }

    return { upperDir: '', workDir: '' };
  }

  /**
   * Pull an image with a longer, but still finite, total mutation deadline.
   * Progress does not reset it: a daemon that emits progress forever is still
   * a mutation that never settled.
   */
  async pullImage(ref: string, onProgress?: (msg: string) => void): Promise<void> {
    if (this.failStopTriggered) {
      await new Promise<void>(() => { /* process is terminating */ });
      return;
    }
    await new Promise<void>((resolve, reject) => {
      let watchdog: NodeJS.Timeout | null = null;
      let stream: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | null = null;
      let settled = false;
      let pullError: Error | null = null;
      const finish = (error?: Error | null) => {
        if (settled) return;
        settled = true;
        stopWatchdog();
        if (error) reject(error);
        else resolve();
      };
      const failStopTransport = (operation: string, error: unknown) => {
        if (settled) return;
        settled = true;
        stopWatchdog();
        const fatalError = new DockerMutationTransportError(operation, error);
        try { stream?.destroy?.(fatalError); } catch { /* Agent still must fail-stop */ }
        this.triggerMutationFailStop(fatalError);
        // Deliberately no resolve/reject: the image mutation may still commit.
      };
      const armWatchdog = () => {
        if (settled) return;
        if (watchdog) return;
        watchdog = setTimeout(() => {
          if (settled) return;
          settled = true;
          stopWatchdog();
          const error = new DockerMutationDeadlineError(
            `pull(${ref}) progress`,
            this.pullDeadlineMs,
          );
          // Destroy best-effort, then fail-stop. Never return an incomplete
          // result while dockerd may still be pulling in the background.
          try { stream?.destroy?.(error); } catch { /* Agent still must fail-stop */ }
          this.triggerMutationFailStop(error);
        }, this.pullDeadlineMs);
        watchdog.unref();
      };
      const stopWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

      armWatchdog();
      this.docker.pull(ref, (err: Error | null, pullStream: NodeJS.ReadableStream) => {
        if (settled) {
          (pullStream as (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | undefined)?.destroy?.();
          return;
        }
        if (err) {
          if (hasDockerHttpStatusCode(err)) finish(err);
          else failStopTransport(`pull(${ref}) connect`, err);
          return;
        }
        stream = pullStream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
        let responseEnded = false;
        pullStream.once('end', () => { responseEnded = true; });
        this.docker.modem.followProgress(
          pullStream,
          (err2: Error | null) => {
            if (err2) {
              if (hasDockerHttpStatusCode(err2)) finish(err2);
              else failStopTransport(`pull(${ref}) progress`, err2);
              return;
            }
            if (!responseEnded) {
              failStopTransport(`pull(${ref}) progress`, new Error('Docker pull response closed before end'));
              return;
            }
            finish(pullError);
          },
          (event: { status?: string; error?: string; errorDetail?: { message?: string } }) => {
            const daemonError = event.errorDetail?.message ?? event.error;
            if (daemonError && !pullError) pullError = new Error(`Docker pull failed: ${daemonError}`);
            onProgress?.(event.status ?? daemonError ?? '');
          },
        );
      });
    });
  }

  async fetchContainerStats(dockerId: string): Promise<ContainerStatsSummary> {
    const statsData = await withAbortableDockerRead(
      (signal) => this.docker.getContainer(dockerId).stats({
        stream: false,
        abortSignal: signal,
      } as { stream: false; abortSignal: AbortSignal }) as unknown as Promise<Record<string, unknown>>,
      TIMEOUT_STATS_MS,
      `stats(${dockerId.slice(0, 12)})`,
    );
    return this.parseDockerStats(statsData);
  }

  private parseDockerStats(stats: Record<string, unknown>): ContainerStatsSummary {
    const cpu = stats.cpu_stats as Record<string, unknown>;
    const preCpu = stats.precpu_stats as Record<string, unknown>;
    const mem = stats.memory_stats as Record<string, unknown>;
    const net = stats.networks as Record<string, { rx_bytes: number; tx_bytes: number }>;

    const cpuDelta =
      ((cpu.cpu_usage as Record<string, number>).total_usage ?? 0) -
      ((preCpu.cpu_usage as Record<string, number>).total_usage ?? 0);
    const cpuUsageNs = (cpu.cpu_usage as Record<string, number>).total_usage ?? 0;
    const systemDelta = ((cpu.system_cpu_usage as number) ?? 0) - ((preCpu.system_cpu_usage as number) ?? 0);
    const numCpus = (cpu.online_cpus as number) ?? 1;
    const cpuRatio = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus : 0;

    const netRx = Object.values(net ?? {}).reduce((a, v) => a + v.rx_bytes, 0);
    const netTx = Object.values(net ?? {}).reduce((a, v) => a + v.tx_bytes, 0);

    const blkio = (stats.blkio_stats as Record<string, Array<{ op: string; value: number }>>) ?? {};
    const blkStats = blkio.io_service_bytes_recursive ?? [];
    const blkRead = blkStats
      .filter((s) => s.op.toLowerCase() === 'read')
      .reduce((a, s) => a + s.value, 0);
    const blkWrite = blkStats
      .filter((s) => s.op.toLowerCase() === 'write')
      .reduce((a, s) => a + s.value, 0);

    return {
      cpuUsageRatio: cpuRatio,
      cpuUsageUsec: Math.floor(cpuUsageNs / 1_000),
      memUsedBytes: (mem.usage as number) ?? 0,
      memLimitBytes: (mem.limit as number) ?? 0,
      netRxBytes: netRx,
      netTxBytes: netTx,
      blockReadBytes: blkRead,
      blockWriteBytes: blkWrite,
      gpuMemUsedMiB: {},
    };
  }

  /**
   * A Docker mutation cannot be safely abandoned: dockerd may still commit it
   * after a caller-side deadline or transport rejection. Only a settled
   * Docker HTTP response (identified by statusCode) is safe to propagate.
   * Ambiguous outcomes fail-stop the whole Agent and deliberately leave this
   * Promise pending. An injected test hook may return, but the same process
   * still cannot observe completion or start a later mutation through this
   * client.
   */
  private runMutation<T>(
    operation: string,
    start: () => Promise<T>,
    timeoutMs = this.mutationDeadlineMs,
  ): Promise<T> {
    if (this.failStopTriggered) return new Promise<T>(() => { /* process is terminating */ });

    let physical: Promise<T>;
    try {
      physical = start();
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let claimed = false;
      const timer = setTimeout(() => {
        if (claimed) return;
        claimed = true;
        this.triggerMutationFailStop(new DockerMutationDeadlineError(
          operation,
          timeoutMs,
        ));
        // No resolve/reject: production is being killed, and a returning test
        // hook must not make the mutation replayable in this process.
      }, timeoutMs);
      timer.unref();
      physical.then(
        (value) => {
          if (claimed) return;
          claimed = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (claimed) return;
          claimed = true;
          clearTimeout(timer);
          if (hasDockerHttpStatusCode(error)) {
            reject(error);
            return;
          }
          this.triggerMutationFailStop(new DockerMutationTransportError(operation, error));
          // No resolve/reject: a socket rejection is not a Docker completion
          // barrier and the daemon may still commit the mutation later.
        },
      );
    });
  }

  private triggerMutationFailStop(error: DockerMutationFailStopError): void {
    if (this.failStopTriggered) return;
    this.failStopTriggered = true;
    try {
      this.fatalHook(error);
    } catch (fatalError) {
      console.error('[Docker] Injected fatal hook failed; forcing SIGKILL', fatalError);
      killAgentAfterAmbiguousMutation(error);
    }
  }

  /**
   * Resolve only after the interactive exec is physically absent. A normal
   * attach close and an explicit close deliberately share this path: Docker
   * may close the transport while the exec continues to run.
   */
  private async completeInteractiveExec(exec: Dockerode.Exec, dockerId: string): Promise<number> {
    const deadlineAt = Date.now() + INTERACTIVE_EXEC_TERMINATION_DEADLINE_MS;
    const barrierReserveMs = Math.min(5_000, Math.floor(INTERACTIVE_EXEC_TERMINATION_DEADLINE_MS / 2));
    const workDeadlineAt = deadlineAt - barrierReserveMs;
    const operation = `interactive exec termination(${dockerId.slice(0, 12)})`;

    try {
      const initial = await this.inspectInteractiveExec(exec, workDeadlineAt, `${operation}.initial`);
      const initialExit = this.provenExecExitCode(initial);
      if (initialExit !== null) return initialExit;
    } catch {
      // A missing or timed-out observation is not proof that the exec exited.
      // The exact container becomes the deliberately coarse rollback barrier.
    }

    // dockerode exposes no race-free exec kill primitive. Signalling its host
    // PID after reading /proc has an unavoidable PID-reuse TOCTOU and could
    // kill an unrelated host process. Correctness is intentionally coarse:
    // any exec not already proven terminal rolls back by stopping its exact
    // container, then freshly proving stopped/absent.
    return await this.completeInteractiveExecByStoppingContainer(dockerId, deadlineAt);
  }

  private async completeInteractiveExecFailClosed(
    exec: Dockerode.Exec,
    dockerId: string,
  ): Promise<number> {
    try {
      return await this.completeInteractiveExec(exec, dockerId);
    } catch (error) {
      this.triggerMutationFailStop(new DockerObservationAmbiguityError(
        `interactive exec fail-closed barrier(${dockerId.slice(0, 12)}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      ));
      return new Promise<never>(() => { /* production is terminating */ });
    }
  }

  private async inspectInteractiveExec(
    exec: Dockerode.Exec,
    deadlineAt: number,
    operation: string,
  ): Promise<Dockerode.ExecInspectInfo> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new DockerTimeoutError(operation, 0);
    return withAbortableDockerRead(
      (signal) => exec.inspect({ abortSignal: signal }),
      Math.max(1, Math.min(TIMEOUT_INSPECT_MS, remaining)),
      operation,
    );
  }

  private provenExecExitCode(info: Dockerode.ExecInspectInfo): number | null {
    return info.Running === false && Number.isSafeInteger(info.ExitCode)
      ? info.ExitCode!
      : null;
  }

  private async completeInteractiveExecByStoppingContainer(
    dockerId: string,
    deadlineAt: number,
  ): Promise<number> {
    await this.stopExactContainerForExecBarrier(dockerId, deadlineAt);
    // Container stopped/absent proves the exec is gone, but if exec.inspect
    // could not provide a trustworthy integer status the session is failure.
    return -1;
  }

  parseContainerRuntimeObservation(
    labels: Record<string, string>,
    container?: {
      NetworkSettings?: {
        Networks?: Record<string, {
          IPAddress?: string;
          IPAMConfig?: { IPv4Address?: string };
        }>;
      };
    },
  ): Pick<ContainerRuntimeObservation, 'ip' | 'serverId' | 'specGeneration'> | null {
    const containerId = labels[LABEL.CONTAINER_ID];
    const serverId = labels[LABEL.SERVER_ID];
    const specGeneration = labels[LABEL.SPEC_GENERATION];
    const runtimeSpecHash = labels[LABEL.RUNTIME_SPEC_HASH];
    if (
      labels[LABEL.MANAGED] !== 'true'
      || !containerId
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(containerId)
      || !serverId
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(serverId)
      || !specGeneration
      || !/^[1-9]\d{0,19}$/.test(specGeneration)
      || !runtimeSpecHash
      || !/^[a-f0-9]{64}$/.test(runtimeSpecHash)
    ) return null;
    const ip = this.ipFromContainerObservation(container);
    try {
      if (canonicalIpv4Address(ip) !== ip) return null;
    } catch {
      return null;
    }
    return {
      ip,
      serverId,
      specGeneration,
    };
  }

  private ipFromContainerObservation(
    container?: {
      NetworkSettings?: {
        Networks?: Record<string, {
          IPAddress?: string;
          IPAMConfig?: { IPv4Address?: string };
        }>;
      };
    },
  ): string {
    const networks = container?.NetworkSettings?.Networks ?? {};
    const network = networks[NYABASE_NETWORK];
    return network?.IPAddress || network?.IPAMConfig?.IPv4Address || '';
  }

}
