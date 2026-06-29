import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';
import {
  BackendToAgentMessage,
  AgentCommandKind,
  CheckDiskResult,
  ContainerMountSpec,
  AgentToBackendMessage,
  SelfCheckResult,
  SelfCheckItem,
  zAgentCommandEnvelope,
  zContainerSetPowerPayload,
  zDeleteContainerPayload,
  zUpdateUserQuotaPayload,
  zPullImagePayload,
  zExecStreamPayload,
  zExecResizePayload,
  zExecInputPayload,
  zExecClosePayload,
  zCreateDataDirPayload,
  zDeleteDataDirPayload,
  zFetchContainerStatsPayload,
  zCheckDiskPayload,
  zApplyDataDiskPayload,
  zRemoveDataDiskPayload,
  zApplyRemoteFsMountPayload,
  zRemoveRemoteFsMountPayload,
  zReconcileContainerMountsPayload,
  zCreateContainerPayload,
  zReconcileContainerSshPayload,
  type AgentCommandEnvelope,
  type CreateContainerPayload,
  type OperationProgressPayload,
} from '@nyabase/common';
import { AgentConfig } from '../config.js';
import { DockerClient } from '../docker/docker-client.js';
import { DaemonManager } from '../docker/daemon-manager.js';
import { XfsQuotaManager } from '../quota/xfs-quota.js';
import { DataDirsManager } from '../datadirs/data-dirs.js';
import { RemoteFsMounter } from '../fs/remote-fs-mounter.js';
import { AgentWsClient } from '../ws/client.js';
import { DropbearManager } from '../dropbear/dropbear-manager.js';
import {
  findLongestContainingProcMount,
  parseProcMounts,
  readProcMountsFresh,
  type ProcMountEntry,
} from '../fs/proc-mounts.js';

const execFileAsync = promisify(execFile);
const COMMAND_HANDLED = Symbol('COMMAND_HANDLED');
type CommandExecutionResult = unknown | typeof COMMAND_HANDLED;

const DIRECT_COMMAND_KINDS = new Set<string>([
  'execStream',
  'execResize',
  'execInput',
  'execClose',
  'reconcile',
  'fetchContainerStats',
  'checkDisk',
  'selfCheck',
  'reconcileDockerDaemon',
]);

function parseCreateContainerPayload(payload: unknown): CreateContainerPayload {
  return zCreateContainerPayload.parse(payload);
}

/**
 * Per-dockerId mutex map with LRU eviction.
 *
 * Naive `Map<string, Mutex>` leaks one Mutex per container ever seen — even
 * after the container is gone the entry sits there forever. We cap the map
 * at MUTEX_MAX_ENTRIES and evict the least-recently-used entry on overflow.
 * Entries are also actively removed by `deleteContainer`.
 *
 * Note: we don't use `Map`'s insertion-order semantics directly for "LRU"
 * because re-insertion (delete-then-set) would also reset the order on
 * `set`. That's exactly the property we want here, so we lean on it.
 */
const MUTEX_MAX_ENTRIES = 512;
const dockerMutexes = new Map<string, Mutex>();

function getDockerMutex(dockerId: string): Mutex {
  const existing = dockerMutexes.get(dockerId);
  if (existing) {
    // Refresh recency (re-insertion moves to end of Map iteration order).
    dockerMutexes.delete(dockerId);
    dockerMutexes.set(dockerId, existing);
    return existing;
  }
  const m = new Mutex();
  dockerMutexes.set(dockerId, m);
  if (dockerMutexes.size > MUTEX_MAX_ENTRIES) {
    const oldestKey = dockerMutexes.keys().next().value;
    if (oldestKey !== undefined) dockerMutexes.delete(oldestKey);
  }
  return m;
}

export function withDockerMutex<T>(dockerId: string, fn: () => Promise<T>): Promise<T> {
  return getDockerMutex(dockerId).runExclusive(fn);
}

/** @internal — exposed for tests. */
export function _dockerMutexesForTest(): Map<string, Mutex> {
  return dockerMutexes;
}

type ExecHandles = { kill: () => void; resize: (c: number, r: number) => void; write: (data: string) => void };
type PendingExecSession = {
  inputs: string[];
  resize?: { cols: number; rows: number };
  close: boolean;
};
type ContainerMountEntry = { dst: string; src: string };
type ContainerMountSourceKind = ContainerMountSpec['sourceKind'];
type ContainerMountSourceProof = { ok: true; detail: string } | { ok: false; reason: string };

export class CommandDispatcher {
  private execSessions = new Map<string, ExecHandles>();
  private pendingExecSessions = new Map<string, PendingExecSession>();

  constructor(
    private config: AgentConfig,
    private docker: DockerClient,
    private quota: XfsQuotaManager,
    private dataDirs: DataDirsManager,
    private remoteFsMounter: RemoteFsMounter,
    private ws: AgentWsClient,
    private dropbearManager: DropbearManager,
    private daemonManager?: DaemonManager,
    private getGpuMemUsedMiB?: (dockerId: string) => Promise<Record<string, number>>,
  ) {}

  // ---------------------------------------------------------------------------
  // Main dispatch entry point
  // ---------------------------------------------------------------------------

  async handle(msg: BackendToAgentMessage): Promise<void> {
    if (msg.kind === 'agentCommand') {
      await this.handleAgentCommand(zAgentCommandEnvelope.parse(msg.payload));
      return;
    }

    const commandId = msg.id ?? '';
    if (!DIRECT_COMMAND_KINDS.has(msg.kind)) {
      this.ack(
        commandId,
        false,
        undefined,
        `Direct command ${msg.kind} is disabled; lifecycle commands must use agentCommand`,
      );
      return;
    }

    try {
      const data = await this.executeCommand(msg.kind, msg.payload, commandId);
      if (data !== COMMAND_HANDLED) {
        this.ack(commandId, true, data);
      }
    } catch (err) {
      console.error(`[Dispatcher] Command failed [${msg.kind}]:`, err);
      this.ack(commandId, false, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  private async handleAgentCommand(envelope: AgentCommandEnvelope): Promise<void> {
    const progress = (
      status: OperationProgressPayload['status'],
      step: string,
      data?: unknown,
      error?: string,
    ) => this.progress(envelope, status, step, data, error);

    try {
      progress('accepted', envelope.commandKind);
      progress('running', envelope.commandKind);
      const data = await this.executeCommand(
        envelope.commandKind,
        envelope.payload,
        envelope.commandId,
      );
      const result = data === COMMAND_HANDLED ? undefined : data;
      progress('succeeded', envelope.commandKind, result);
      this.ack(envelope.commandId, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Dispatcher] Durable command failed [${envelope.commandKind}]:`, error);
      progress('failed', envelope.commandKind, undefined, message);
      this.ack(envelope.commandId, false, undefined, message);
    }
  }

  private async executeCommand(
    kind: string,
    payload: unknown,
    commandId: string,
  ): Promise<CommandExecutionResult> {
    switch (kind) {
      case AgentCommandKind.Noop:
        return undefined;

      case AgentCommandKind.RuntimeContainerCreate:
        return this.handleCreateContainer(parseCreateContainerPayload(payload));

      case AgentCommandKind.RuntimeContainerPower: {
        const p = zContainerSetPowerPayload.parse(payload);
        switch (p.action) {
          case 'start':
            await this.docker.startContainer(p.runtimeId);
            break;
          case 'stop':
            try { await this.docker.stopContainer(p.runtimeId, p.timeoutSeconds); } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              if (!m.includes('304') && !m.toLowerCase().includes('already stopped')) throw err;
            }
            break;
          case 'restart':
            await this.docker.restartContainer(p.runtimeId, p.timeoutSeconds);
            break;
        }
        return undefined;
      }

      case AgentCommandKind.RuntimeContainerDelete: {
        const p = zDeleteContainerPayload.parse(payload);
        await this.docker.removeContainer(p.runtimeId, p.force);
        dockerMutexes.delete(p.runtimeId);
        return undefined;
      }

      case AgentCommandKind.QuotaApply: {
        const p = zUpdateUserQuotaPayload.parse(payload);
        await this.quota.setLimit(p.numericUserId, p.diskBytes);
        return undefined;
      }

      case AgentCommandKind.ImagePull:
        await this.handlePullImage(commandId, zPullImagePayload.parse(payload));
        return COMMAND_HANDLED;

      case 'execStream':
        await this.handleExecStream(commandId, zExecStreamPayload.parse(payload));
        return COMMAND_HANDLED;

      case 'execResize': {
        const p = zExecResizePayload.parse(payload);
        const handles = this.execSessions.get(p.sessionId);
        if (handles) handles.resize(p.cols, p.rows);
        else this.pendingExec(p.sessionId).resize = { cols: p.cols, rows: p.rows };
        return COMMAND_HANDLED;
      }

      case 'execInput': {
        const p = zExecInputPayload.parse(payload);
        const handles = this.execSessions.get(p.sessionId);
        if (handles) handles.write(p.data);
        else this.pendingExec(p.sessionId).inputs.push(p.data);
        return COMMAND_HANDLED;
      }

      case 'execClose': {
        const p = zExecClosePayload.parse(payload);
        const handles = this.execSessions.get(p.sessionId);
        if (handles) { handles.kill(); this.execSessions.delete(p.sessionId); }
        else this.pendingExec(p.sessionId).close = true;
        return COMMAND_HANDLED;
      }

      case AgentCommandKind.DataDirApply: {
        const p = zCreateDataDirPayload.parse(payload);
        const dirPath = await this.dataDirs.createDir(p.diskId, p.name, p.uid);
        const src = this.dataDirs.getSource(p.diskId);
        if (src?.kind === 'local' && src.quotaEnabled) {
          await this.quota.addPathToProject(p.numericUserId, dirPath);
        }
        this.ws.emit('dataDirChanged');
        return undefined;
      }

      case AgentCommandKind.DataDirDelete: {
        const p = zDeleteDataDirPayload.parse(payload);
        await this.dataDirs.deleteDir(p.diskId, p.name);
        this.ws.emit('dataDirChanged');
        return undefined;
      }

      case 'reconcile':
        this.ws.emit('reconcile');
        return COMMAND_HANDLED;

      case 'fetchContainerStats': {
        const p = zFetchContainerStatsPayload.parse(payload);
        return this.docker.fetchContainerStatsWithGpuMem(p.runtimeId, this.getGpuMemUsedMiB);
      }

      case 'checkDisk': {
        const p = zCheckDiskPayload.parse(payload);
        return this.checkDisk(p.mountPoint);
      }

      case AgentCommandKind.DiskApply: {
        const p = zApplyDataDiskPayload.parse(payload);
        return this.handleApplyDataDisk(p.diskId, p.mountPoint, p.label);
      }

      case AgentCommandKind.DiskRemove: {
        const p = zRemoveDataDiskPayload.parse(payload);
        this.handleRemoveDataDisk(p.diskId);
        return undefined;
      }

      case AgentCommandKind.RemoteFsApply: {
        const p = zApplyRemoteFsMountPayload.parse(payload);
        await this.remoteFsMounter.applyMount({
          id: p.id, hostMountPoint: p.hostMountPoint, options: p.options, params: p.params,
        });
        this.dataDirs.addSource({ kind: 'remote', id: p.id, root: p.hostMountPoint, quotaEnabled: false });
        return undefined;
      }

      case AgentCommandKind.RemoteFsRemove: {
        const p = zRemoveRemoteFsMountPayload.parse(payload);
        await this.remoteFsMounter.removeMount(p.id, p.force);
        this.dataDirs.removeSource(p.id);
        return undefined;
      }

      case AgentCommandKind.RuntimeContainerMountsApply: {
        const p = zReconcileContainerMountsPayload.parse(payload);
        return getDockerMutex(p.runtimeId).runExclusive(() =>
          this.reconcileContainerMounts(p.runtimeId, p.expected, p.toRemove),
        );
      }

      case 'selfCheck':
        return this.runSelfCheck();

      case AgentCommandKind.RuntimeContainerSshApply:
        return this.dropbearManager.reconcileContainerSsh(
          zReconcileContainerSshPayload.parse(payload),
        );

      case 'reconcileDockerDaemon':
        if (!this.daemonManager) {
          throw new Error('DaemonManager not available');
        }
        return this.daemonManager.reconcile(this.config.serverId);

      default:
        console.warn('[Dispatcher] Unknown command kind:', kind);
        return COMMAND_HANDLED;
    }
  }

  // ---------------------------------------------------------------------------
  // Ack helpers
  // ---------------------------------------------------------------------------

  private ack(commandId: string, ok: boolean, data?: unknown, error?: string): void {
    if (!commandId) return;
    this.ws.send({
      id: uuidv4(), ts: Date.now(), kind: 'commandAck',
      payload: { commandId, ok, ...(data !== undefined && { data }), ...(error && { error }) },
    } as AgentToBackendMessage);
  }

  private progress(
    envelope: AgentCommandEnvelope,
    status: OperationProgressPayload['status'],
    step: string,
    data?: unknown,
    error?: string,
  ): void {
    this.ws.send({
      id: uuidv4(),
      ts: Date.now(),
      kind: 'operationProgress',
      payload: {
        operationId: envelope.operationId,
        commandId: envelope.commandId,
        status,
        step,
        ...(data !== undefined ? { data } : {}),
        ...(error ? { error } : {}),
        ts: Date.now(),
      },
    } as AgentToBackendMessage);
  }

  // ---------------------------------------------------------------------------
  // createContainer
  // ---------------------------------------------------------------------------

  private async handleCreateContainer(
    payload: CreateContainerPayload,
  ): Promise<{ runtimeId: string; ip: string }> {
    const {
      containerId,
      ownerId,
      numericOwnerId,
      imageDockerRef,
      imageId,
      runtimeOverrides,
      name,
      cpuMillis,
      memBytes,
    } = payload;

    // Compensation stack — every effectful step pushes a rollback function.
    // On failure we pop in reverse order; each compensation has its own
    // try/catch so one bad rollback never masks the original error.
    const compensations: Array<() => Promise<void>> = [];
    const pushComp = (label: string, fn: () => Promise<void>) => {
      compensations.push(async () => {
        try {
          await fn();
        } catch (e) {
          console.warn(`[Dispatcher] Compensation '${label}' failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      });
    };

    try {
      // XFS quota uses the numeric ID; container name/label/paths continue to use UUID ownerId.
      await this.quota.ensureProjectForUser(numericOwnerId);

      const cidr = payload.ipCidr ?? this.config.macvlanCidr;
      const gateway = payload.gateway ?? this.config.macvlanGateway;
      const reservedIps = payload.reservedIps ?? [];
      const ip = await this.docker.allocateNextIp(cidr, [gateway, ...reservedIps]);
      const gpuIndices: number[] = payload.gpuIndices ?? [];

      const dockerId = await this.docker.createContainer({
        name, imageRef: imageDockerRef, cpuMillis, memBytes, gpuIndices,
        ip, containerId, ownerId, imageId, runtimeOverrides, serverId: this.config.serverId,
      });
      pushComp(`removeContainer(${dockerId.slice(0, 12)})`, async () => {
        await this.docker.removeContainer(dockerId, true);
      });

      await this.docker.startContainer(dockerId);
      // start has no separate compensation: removeContainer(force=true) above
      // also stops a running container.

      const { upperDir, workDir } = await this.docker.getGraphDriverDirs(dockerId);
      if (!upperDir) {
        throw new Error(`Docker writable layer path not found for container ${dockerId}; cannot enforce disk quota`);
      }
      if (!workDir) {
        throw new Error(`Docker writable work path not found for container ${dockerId}; cannot enforce disk quota`);
      }
      await this.quota.addPathToProject(numericOwnerId, upperDir);
      pushComp(`xfsQuotaRemove(${upperDir})`, async () => {
        this.quota.removePathFromProject(numericOwnerId, upperDir);
      });
      await this.quota.addPathToProject(numericOwnerId, workDir);
      pushComp(`xfsQuotaRemove(${workDir})`, async () => {
        this.quota.removePathFromProject(numericOwnerId, workDir);
      });

      return { runtimeId: dockerId, ip };
    } catch (err) {
      // Roll back in LIFO order. Each compensation is self-catching.
      for (let i = compensations.length - 1; i >= 0; i--) {
        await compensations[i]();
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Data disk management
  // ---------------------------------------------------------------------------

  private async handleApplyDataDisk(diskId: string, mountPoint: string, _label?: string): Promise<{ diskId: string }> {
    const check = await this.checkDisk(mountPoint);
    if (!check.exists) throw new Error(`路径不存在: ${mountPoint}`);
    if (!check.isXfs) throw new Error(`路径 ${mountPoint} 文件系统为 ${check.fsType}，必须为 XFS`);
    const capability = await this.quota.checkProjectQuotaEnforcement(mountPoint);
    if (!capability.accounting || !capability.enforcement) {
      const status = `accounting=${capability.accounting ? 'on' : 'off'}, enforcement=${capability.enforcement ? 'on' : 'off'}`;
      throw new Error(
        `路径 ${mountPoint} 未启用 XFS project quota enforcement (${status})${capability.output ? `: ${capability.output}` : ''}`,
      );
    }
    this.dataDirs.addSource({ kind: 'local', id: diskId, root: mountPoint, quotaEnabled: true });
    return { diskId };
  }

  private handleRemoveDataDisk(diskId: string): void {
    this.dataDirs.removeSource(diskId);
  }

  // ---------------------------------------------------------------------------
  // Container mount reconciliation
  // ---------------------------------------------------------------------------

  private async reconcileContainerMounts(
    dockerId: string,
    expected: ContainerMountSpec[],
    toRemove?: string[],
  ): Promise<{ current: ContainerMountEntry[] }> {
    const inspect = await this.docker.inspectContainer(dockerId);
    const pid = inspect.State.Pid;
    if (!pid || inspect.State.Status !== 'running') {
      return { current: [] };
    }

    const current = await this.listContainerMounts(pid);
    const currentMap = new Map(current.map((m) => [m.dst, m]));

    if (toRemove) {
      for (const containerPath of toRemove) {
        if (currentMap.has(containerPath)) {
          await this.runMountHelper('umount', ['--pid', String(pid), '--dst', containerPath]);
          currentMap.delete(containerPath);
        }
      }
    }

    for (const spec of expected) {
      const cur = currentMap.get(spec.containerPath);
      if (!cur) {
        await this.runMountHelper('mount', ['--pid', String(pid), '--src', spec.hostPath, '--dst', spec.containerPath]);
      } else {
        const sourceProof = await this.verifyContainerMountSource(spec.hostPath, cur.src, spec.sourceKind);
        if (sourceProof.ok) continue;

        await this.runMountHelper('umount', ['--pid', String(pid), '--dst', spec.containerPath]);
        await this.runMountHelper('mount', ['--pid', String(pid), '--src', spec.hostPath, '--dst', spec.containerPath]);
      }
    }

    const verifiedCurrent = await this.listContainerMounts(pid);
    await this.verifyExpectedContainerMounts(dockerId, pid, expected, verifiedCurrent, 'reconcileContainerMounts');
    return { current: verifiedCurrent };
  }

  private async listContainerMounts(pid: number): Promise<ContainerMountEntry[]> {
    try {
      const { stdout } = await execFileAsync(this.config.mountHelperPath, ['list', '--pid', String(pid)], { timeout: 10_000 });
      return JSON.parse(stdout) as ContainerMountEntry[];
    } catch (e) {
      console.warn('[Dispatcher] mount-helper list failed:', e);
      return [];
    }
  }

  private async verifyExpectedContainerMounts(
    dockerId: string,
    pid: number,
    expected: ContainerMountSpec[],
    current: ContainerMountEntry[],
    operation: string,
  ): Promise<void> {
    const currentByDestination = new Map(current.map((m) => [m.dst, m]));
    const failures: string[] = [];

    for (const spec of expected) {
      const actual = currentByDestination.get(spec.containerPath);
      if (!actual) {
        failures.push(
          `missing mount dockerId=${dockerId} pid=${pid} source=${spec.hostPath} destination=${spec.containerPath} expectedSource=${spec.hostPath} actualSource=<missing> proofFailure=destination not present in mount-helper list`,
        );
        continue;
      }

      const sourceProof = await this.verifyContainerMountSource(spec.hostPath, actual.src, spec.sourceKind);
      if (!sourceProof.ok) {
        failures.push(
          `mismatched mount dockerId=${dockerId} pid=${pid} expectedSource=${spec.hostPath} actualSource=${actual.src} destination=${spec.containerPath} proofFailure=${sourceProof.reason}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(`Container mount verification failed after ${operation}: ${failures.join('; ')}`);
    }
  }

  private async verifyContainerMountSource(
    expectedHostPath: string,
    actualSource: string,
    sourceKind: ContainerMountSourceKind,
  ): Promise<ContainerMountSourceProof> {
    if (actualSource === expectedHostPath) {
      return { ok: true, detail: 'exact source match' };
    }

    let resolvedExpectedHostPath: string;
    try {
      resolvedExpectedHostPath = await fs.promises.realpath(expectedHostPath);
    } catch (e) {
      return {
        ok: false,
        reason: `expected host source realpath failed: ${this.errorMessage(e)}`,
      };
    }

    let procMounts: ProcMountEntry[];
    try {
      procMounts = parseProcMounts(await readProcMountsFresh());
    } catch (e) {
      return {
        ok: false,
        reason: `fresh /proc/mounts read failed: ${this.errorMessage(e)}`,
      };
    }

    const containingMount = findLongestContainingProcMount(
      await this.resolveProcMountPoints(procMounts),
      resolvedExpectedHostPath,
    );
    if (!containingMount) {
      return {
        ok: false,
        reason: `no containing host mount for resolved source ${resolvedExpectedHostPath}`,
      };
    }

    if (sourceKind === 'local') {
      return this.verifyLocalXfsContainerMountSource(containingMount, actualSource);
    }

    if (!this.isNfsProcMount(containingMount)) {
      return {
        ok: false,
        reason: `containing host mount ${containingMount.mountPoint} is ${containingMount.fsType}, not nfs/nfs4`,
      };
    }

    if (!this.isNfsSource(containingMount.source)) {
      return {
        ok: false,
        reason: `containing host mount source ${containingMount.source} is not a provable NFS source`,
      };
    }

    const relativeSuffix = path.posix.relative(containingMount.mountPoint, resolvedExpectedHostPath);
    if (relativeSuffix === '..' || relativeSuffix.startsWith('../') || path.posix.isAbsolute(relativeSuffix)) {
      return {
        ok: false,
        reason: `resolved source ${resolvedExpectedHostPath} is outside host mount ${containingMount.mountPoint}`,
      };
    }

    const canonicalBackedSource = this.appendSourceSuffix(containingMount.source, relativeSuffix);
    if (canonicalBackedSource !== actualSource) {
      return {
        ok: false,
        reason: `canonical NFS source ${canonicalBackedSource} did not equal actual source ${actualSource}`,
      };
    }

    return {
      ok: true,
      detail: `canonical NFS source ${canonicalBackedSource}`,
    };
  }

  private async verifyLocalXfsContainerMountSource(
    containingMount: ProcMountEntry,
    actualSource: string,
  ): Promise<ContainerMountSourceProof> {
    if (!this.isXfsProcMount(containingMount)) {
      return {
        ok: false,
        reason: `containing host mount ${containingMount.mountPoint} is ${containingMount.fsType}, not xfs for local source`,
      };
    }

    const sourceMatch = await this.localMountSourcesMatch(containingMount.source, actualSource);
    if (!sourceMatch.ok) {
      return {
        ok: false,
        reason: `local XFS backing source ${containingMount.source} did not equal actual source ${actualSource}${sourceMatch.detail ? ` (${sourceMatch.detail})` : ''}`,
      };
    }

    return {
      ok: true,
      detail: `local XFS backing source ${sourceMatch.detail}`,
    };
  }

  private async resolveProcMountPoints(entries: ProcMountEntry[]): Promise<ProcMountEntry[]> {
    return Promise.all(entries.map(async (entry) => {
      try {
        return { ...entry, mountPoint: await fs.promises.realpath(entry.mountPoint) };
      } catch {
        return entry;
      }
    }));
  }

  private isXfsProcMount(entry: ProcMountEntry): boolean {
    return entry.fsType.toLowerCase() === 'xfs';
  }

  private isNfsProcMount(entry: ProcMountEntry): boolean {
    const fsType = entry.fsType.toLowerCase();
    return fsType === 'nfs' || fsType === 'nfs4';
  }

  private isNfsSource(source: string): boolean {
    return /^[^:]+:\/.*$/.test(source) || /^\[[^\]]+\]:\/.*$/.test(source);
  }

  private appendSourceSuffix(source: string, relativeSuffix: string): string {
    if (!relativeSuffix || relativeSuffix === '.') return source;
    return `${source.replace(/\/+$/, '')}/${relativeSuffix}`;
  }

  private async localMountSourcesMatch(
    expectedSource: string,
    actualSource: string,
  ): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
    if (actualSource === expectedSource) {
      return { ok: true, detail: expectedSource };
    }

    const normalizedExpected = this.normalizeAbsoluteSourcePath(expectedSource);
    const normalizedActual = this.normalizeAbsoluteSourcePath(actualSource);
    if (normalizedExpected && normalizedActual && normalizedExpected === normalizedActual) {
      return { ok: true, detail: normalizedExpected };
    }

    if (!normalizedExpected || !normalizedActual) {
      return { ok: false, detail: 'non-path source can only be proven by exact match' };
    }

    const [canonicalExpected, canonicalActual] = await Promise.all([
      this.realpathForProof(normalizedExpected),
      this.realpathForProof(normalizedActual),
    ]);
    if (canonicalExpected.ok && canonicalActual.ok && canonicalExpected.path === canonicalActual.path) {
      return { ok: true, detail: canonicalExpected.path };
    }

    return {
      ok: false,
      detail: `canonical expected=${canonicalExpected.ok ? canonicalExpected.path : `<unresolved: ${canonicalExpected.reason}>`} actual=${canonicalActual.ok ? canonicalActual.path : `<unresolved: ${canonicalActual.reason}>`}`,
    };
  }

  private normalizeAbsoluteSourcePath(source: string): string | null {
    if (!path.posix.isAbsolute(source)) return null;
    return path.posix.normalize(source);
  }

  private async realpathForProof(source: string): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    try {
      return { ok: true, path: await fs.promises.realpath(source) };
    } catch (e) {
      return { ok: false, reason: this.errorMessage(e) };
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async runMountHelper(subcmd: string, args: string[]): Promise<void> {
    await execFileAsync(this.config.mountHelperPath, [subcmd, ...args], { timeout: 30_000 });
  }

  // ---------------------------------------------------------------------------
  // pullImage
  // ---------------------------------------------------------------------------

  private async handlePullImage(
    commandId: string,
    payload: import('@nyabase/common').PullImagePayload,
  ): Promise<void> {
    const { dockerRef, imageId } = payload;

    const sendProgress = (status: 'pulling' | 'done' | 'error', progress: number, message: string, error?: string) => {
      this.ws.send({
        id: uuidv4(), ts: Date.now(), kind: 'pullProgress',
        payload: { serverId: this.config.serverId, dockerRef, imageId, status, progress, message, error },
      } as AgentToBackendMessage);
    };

    try {
      sendProgress('pulling', 0, 'Starting pull...');
      await new Promise<void>((resolve, reject) => {
        this.docker.docker.pull(dockerRef, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          const layers: Record<string, { current: number; total: number }> = {};
          this.docker.docker.modem.followProgress(
            stream,
            (finalErr: Error | null) => { if (finalErr) reject(finalErr); else resolve(); },
            (event: { status?: string; id?: string; progressDetail?: { current?: number; total?: number } }) => {
              const id = event.id;
              const detail = event.progressDetail;
              if (id && detail?.total) layers[id] = { current: detail.current ?? 0, total: detail.total };
              const vals = Object.values(layers);
              const p = vals.length > 0
                ? Math.round(vals.reduce((a, l) => a + (l.total > 0 ? l.current / l.total : 0), 0) / vals.length * 100)
                : 0;
              sendProgress('pulling', Math.min(p, 99), id ? `${event.status} ${id}` : (event.status ?? ''));
            },
          );
        });
      });
      sendProgress('done', 100, 'Pull complete');
      this.ack(commandId, true);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      sendProgress('error', 0, m, m);
      this.ack(commandId, false, undefined, m);
    }
  }

  // ---------------------------------------------------------------------------
  // execStream
  // ---------------------------------------------------------------------------

  private async handleExecStream(
    commandId: string,
    payload: import('@nyabase/common').ExecStreamPayload,
  ): Promise<void> {
    const { sessionId, runtimeId, cmd, tty, cols, rows } = payload;

    // Ack immediately — the session ID is the correlation key for subsequent logChunks
    this.ack(commandId, true, { sessionId });

    this.docker.exec(
      runtimeId, cmd, tty,
      (data, isErr) => {
        this.ws.send({ id: uuidv4(), ts: Date.now(), kind: 'logChunk', payload: { sessionId, data, stderr: isErr } });
      },
      (exitCode) => {
        this.ws.send({ id: uuidv4(), ts: Date.now(), kind: 'logChunk', payload: { sessionId, data: '', eof: true, exitCode } });
        this.execSessions.delete(sessionId);
      },
    ).then((handles) => {
      const pending = this.pendingExecSessions.get(sessionId);
      this.pendingExecSessions.delete(sessionId);
      if (pending?.close) {
        handles.kill();
        return;
      }
      this.execSessions.set(sessionId, handles);
      const resize = pending?.resize ?? (cols && rows ? { cols, rows } : undefined);
      if (resize) handles.resize(resize.cols, resize.rows);
      for (const input of pending?.inputs ?? []) {
        handles.write(input);
      }
    }).catch((err) => {
      this.pendingExecSessions.delete(sessionId);
      const encoded = Buffer.from(`\r\n\x1b[31m[exec error: ${err instanceof Error ? err.message : err}]\x1b[0m\r\n`).toString('base64');
      this.ws.send({ id: uuidv4(), ts: Date.now(), kind: 'logChunk', payload: { sessionId, data: encoded, eof: true, exitCode: -1 } });
    });
  }

  private pendingExec(sessionId: string): PendingExecSession {
    const existing = this.pendingExecSessions.get(sessionId);
    if (existing) return existing;
    const created: PendingExecSession = { inputs: [], close: false };
    this.pendingExecSessions.set(sessionId, created);
    return created;
  }

  // ---------------------------------------------------------------------------
  // selfCheck
  // ---------------------------------------------------------------------------

  private async runSelfCheck(): Promise<SelfCheckResult> {
    const items: SelfCheckItem[] = [];

    // 1. Docker daemon connectivity
    try {
      await this.docker.docker.ping();
      items.push({ id: 'docker', label: 'Docker 守护进程', status: 'ok', message: 'Docker daemon 响应正常' });
    } catch (err) {
      items.push({ id: 'docker', label: 'Docker 守护进程', status: 'fail', message: `无法连接 Docker: ${err instanceof Error ? err.message : String(err)}` });
    }

    // 2. Docker data directory on XFS
    try {
      const info = await this.docker.docker.info() as { DockerRootDir?: string };
      const rootDir = info.DockerRootDir ?? this.config.dockerRoot;
      const { stdout } = await execFileAsync('stat', ['-f', '-c', '%T', rootDir], { timeout: 5000 });
      const fsType = stdout.trim();
      if (fsType.toLowerCase() === 'xfs') {
        items.push({ id: 'docker_data_xfs', label: 'Docker 数据目录 (XFS)', status: 'ok', message: `${rootDir} 文件系统: xfs` });
      } else {
        items.push({ id: 'docker_data_xfs', label: 'Docker 数据目录 (XFS)', status: 'fail', message: `${rootDir} 文件系统: ${fsType}，需要 XFS` });
      }
    } catch (err) {
      items.push({ id: 'docker_data_xfs', label: 'Docker 数据目录 (XFS)', status: 'warn', message: `检测失败: ${err instanceof Error ? err.message : String(err)}` });
    }

    // 3. Remote FS driver self-checks (NFS, CephFS, ...)
    const driverCheckResults = await Promise.allSettled(this.remoteFsMounter.getDriverSelfChecks());
    for (const r of driverCheckResults) {
      if (r.status === 'fulfilled') {
        items.push(r.value);
      }
    }

    // 4. Dropbear
    const dropbearItems = await this.dropbearManager.getSelfCheckItems();
    items.push(...dropbearItems);

    // 5. xfs_quota
    try {
      await execFileAsync('xfs_quota', ['-V'], { timeout: 3000 });
      items.push({ id: 'xfs_quota', label: 'xfs_quota', status: 'ok', message: 'xfs_quota 已安装' });
    } catch {
      items.push({ id: 'xfs_quota', label: 'xfs_quota', status: 'fail', message: 'xfs_quota 未找到，请安装 xfsprogs' });
    }

    // 6. mkfs.xfs (xfsprogs)
    try {
      await execFileAsync('mkfs.xfs', ['-V'], { timeout: 3000 });
      items.push({ id: 'xfsprogs', label: 'mkfs.xfs (xfsprogs)', status: 'ok', message: 'mkfs.xfs 已安装' });
    } catch {
      items.push({ id: 'xfsprogs', label: 'mkfs.xfs (xfsprogs)', status: 'fail', message: 'mkfs.xfs 未找到，请安装 xfsprogs' });
    }

    return { items };
  }

  // ---------------------------------------------------------------------------
  // checkDisk
  // ---------------------------------------------------------------------------

  private async checkDisk(mountPoint: string): Promise<CheckDiskResult> {
    const exists = fs.existsSync(mountPoint);
    if (!exists) return { exists: false, fsType: '', isXfs: false };
    try {
      const { stdout } = await execFileAsync('stat', ['-f', '-c', '%T', mountPoint], { timeout: 5000 });
      const fsType = stdout.trim();
      return { exists: true, fsType, isXfs: fsType.toLowerCase() === 'xfs' };
    } catch {
      return { exists: true, fsType: 'unknown', isXfs: false };
    }
  }
}
