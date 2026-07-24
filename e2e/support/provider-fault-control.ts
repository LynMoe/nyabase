import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AvailableTopologyProvider,
  TopologyFaultControlInput,
  TopologyFaultControlResult,
} from '../topology/provider.js';
import { runTopologyFaultProviderEntrypoint } from './provider-entrypoint-runner.mjs';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function controlProviderFault<T extends TopologyFaultControlInput>(
  provider: AvailableTopologyProvider,
  input: T,
): Promise<Extract<TopologyFaultControlResult, { fault: T['fault'] }>> {
  const runId = currentRunId();
  if (input.runId !== runId) {
    throw new Error('Topology provider fault operation must target the current E2E run');
  }
  const entrypoint = resolve(repositoryRoot, provider.operations.faultControl.path);
  if (!entrypoint.startsWith(`${repositoryRoot}/e2e/`)) {
    throw new Error('Topology provider fault operation escapes the E2E boundary');
  }

  const stdout = await runTopologyFaultProviderEntrypoint(
    entrypoint,
    requireRuntimeEnv('E2E_RUNTIME_ROOT'),
    input,
  );
  const result = JSON.parse(stdout) as TopologyFaultControlResult;
  assertFaultResult(input, result);
  return result as Extract<TopologyFaultControlResult, { fault: T['fault'] }>;
}

function assertFaultResult(
  input: TopologyFaultControlInput,
  value: TopologyFaultControlResult,
): asserts value is TopologyFaultControlResult {
  if (
    value?.schemaVersion !== 1 ||
    value.runId !== input.runId ||
    value.fault !== input.fault ||
    value.action !== input.action ||
    typeof value.observedAt !== 'string' ||
    Number.isNaN(Date.parse(value.observedAt))
  ) {
    throw new Error('Topology provider returned mismatched fault-control evidence');
  }
  if (input.fault === 'agentService') {
    if (value.fault !== 'agentService') {
      throw new Error('Topology provider returned a mismatched Agent service fault kind');
    }
    const runtimeContainerIds = value.runtimeContainerIds;
    const activeRuntimeContainerIds = value.activeRuntimeContainerIds;
    const validSortedRuntimeIds = (ids: unknown): ids is string[] =>
      Array.isArray(ids) &&
      ids.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) &&
      new Set(ids).size === ids.length &&
      JSON.stringify(ids) === JSON.stringify([...ids].sort());
    const invalidProbeRuntimeIds =
      input.action === 'probe' &&
      (value.serviceActive !== true ||
        !validSortedRuntimeIds(runtimeContainerIds) ||
        !validSortedRuntimeIds(activeRuntimeContainerIds) ||
        activeRuntimeContainerIds.some((id) => !runtimeContainerIds.includes(id)));
    if (
      value.nodeKey !== input.nodeKey ||
      value.containerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}` ||
      (input.action === 'stop' && value.serviceActive !== false) ||
      (['start', 'restart'].includes(input.action) && value.serviceActive !== true) ||
      invalidProbeRuntimeIds ||
      (input.action !== 'probe' &&
        (runtimeContainerIds !== null || activeRuntimeContainerIds !== null))
    ) {
      throw new Error('Topology provider returned invalid Agent service evidence');
    }
    return;
  }
  if (input.fault === 'localDataDirOrphan') {
    if (value.fault !== 'localDataDirOrphan') {
      throw new Error('Topology provider returned a mismatched DataDir orphan fault kind');
    }
    if (
      value.nodeKey !== input.nodeKey ||
      value.containerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}` ||
      value.resourceId !== `${input.runId}:provider-orphan:${input.nodeKey}` ||
      value.sourceId !== `${input.runId}-${input.nodeKey}-local` ||
      !value.sourceIdentity.startsWith('local:xfs:') ||
      value.hostPath !== `/data/nyabase/.nyabase/dirs/${value.resourceId}/data` ||
      typeof value.present !== 'boolean' ||
      (input.action === 'inject' && value.present !== true) ||
      (input.action === 'restore' && value.present !== false) ||
      typeof value.serviceActive !== 'boolean' ||
      (input.action !== 'probe' && value.serviceActive !== true)
    ) {
      throw new Error('Topology provider returned invalid local DataDir orphan evidence');
    }
    return;
  }
  if (input.fault === 'duplicateNetworkClaim') {
    if (value.fault !== 'duplicateNetworkClaim') {
      throw new Error('Topology provider returned a mismatched duplicate network claim kind');
    }
    if (
      value.serverId !== input.serverId ||
      value.containerName !== `nyabase-e2e-${input.runId}-fault-duplicate-claim` ||
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value.conflictingAddress) ||
      typeof value.present !== 'boolean' ||
      (input.action === 'inject' && value.present !== true) ||
      (input.action === 'restore' && value.present !== false) ||
      typeof value.serviceActive !== 'boolean' ||
      value.serviceActive !== value.present
    ) {
      throw new Error('Topology provider returned invalid duplicate network claim evidence');
    }
    return;
  }
  if (input.fault === 'agentTaskWire') {
    if (value.fault !== 'agentTaskWire') {
      throw new Error('Topology provider returned a mismatched Agent task wire fault kind');
    }
    const counters = [
      value.executeCount,
      value.terminalCount,
      value.droppedCount,
      value.mutatedCount,
      value.forwardedTerminalCount,
    ];
    const validNullableTime = (time: unknown): time is string | null =>
      time === null || (typeof time === 'string' && !Number.isNaN(Date.parse(time)));
    if (
      value.nodeKey !== input.nodeKey ||
      value.mode !== input.mode ||
      value.taskId !== input.taskId ||
      value.payloadHash !== input.payloadHash ||
      value.containerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}` ||
      typeof value.serviceActive !== 'boolean' ||
      typeof value.proxyActive !== 'boolean' ||
      typeof value.routeActive !== 'boolean' ||
      typeof value.released !== 'boolean' ||
      counters.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      value.droppedCount > 1 ||
      value.mutatedCount > 1 ||
      value.droppedCount > value.terminalCount ||
      value.mutatedCount > value.forwardedTerminalCount ||
      value.forwardedTerminalCount > value.terminalCount ||
      (value.terminalCount > 0 && value.executeCount === 0) ||
      !validNullableTime(value.firstExecuteAt) ||
      !validNullableTime(value.lastExecuteAt) ||
      !validNullableTime(value.firstTerminalAt) ||
      !validNullableTime(value.lastForwardedTerminalAt) ||
      (value.executeCount === 0) !== (value.firstExecuteAt === null) ||
      (value.executeCount === 0) !== (value.lastExecuteAt === null) ||
      (value.terminalCount === 0) !== (value.firstTerminalAt === null) ||
      (value.forwardedTerminalCount === 0) !== (value.lastForwardedTerminalAt === null) ||
      ((input.mode === 'drop-terminal-once' || input.mode === 'hold-terminal-until-release') &&
        value.mutatedCount !== 0) ||
      (input.mode === 'mutate-image-ref-once' && (value.droppedCount !== 0 || value.released)) ||
      (input.action === 'inject' && value.released) ||
      (input.action === 'release' && !value.released) ||
      (input.action === 'restore' &&
        (!value.serviceActive || value.proxyActive || value.routeActive || value.released)) ||
      (input.action !== 'restore' &&
        (!value.serviceActive || !value.proxyActive || !value.routeActive))
    ) {
      throw new Error('Topology provider returned invalid Agent task wire evidence');
    }
    return;
  }
  if (input.fault === 'backendService') {
    if (
      value.fault !== 'backendService' ||
      value.containerName !== `nyabase-e2e-${input.runId}-backend-1` ||
      !/^[a-f0-9]{64}$/.test(value.containerId) ||
      !/^[a-f0-9]{64}$/.test(value.before?.generation ?? '') ||
      !/^[a-f0-9]{64}$/.test(value.after?.generation ?? '') ||
      value.before?.healthy !== true ||
      value.after?.healthy !== true ||
      value.restarted !== (input.action === 'restart') ||
      (input.action === 'restart' && value.before.generation === value.after.generation) ||
      (input.action === 'probe' && value.before.generation !== value.after.generation)
    ) {
      throw new Error('Topology provider returned invalid Backend service evidence');
    }
    return;
  }
  if (input.fault === 'backendClock') {
    const expectedOffset = input.action === 'advance' ? 691_200_000 : 0;
    if (
      value.fault !== 'backendClock' ||
      value.containerName !== `nyabase-e2e-${input.runId}-backend-1` ||
      (input.action === 'probe'
        ? value.offsetMs !== 0 && value.offsetMs !== 691_200_000
        : value.offsetMs !== expectedOffset) ||
      !/^[a-f0-9]{64}$/.test(value.generation) ||
      value.healthy !== true
    ) {
      throw new Error('Topology provider returned invalid Backend clock evidence');
    }
    return;
  }
  if (input.fault === 'dockerdService') {
    const validIds = (ids: unknown): ids is string[] =>
      Array.isArray(ids) &&
      ids.every((id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)) &&
      new Set(ids).size === ids.length &&
      JSON.stringify(ids) === JSON.stringify([...ids].sort());
    if (
      value.fault !== 'dockerdService' ||
      value.nodeKey !== input.nodeKey ||
      value.containerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}` ||
      value.serviceActive !== true ||
      !/^[a-f0-9]{64}$/.test(value.beforeGeneration) ||
      !/^[a-f0-9]{64}$/.test(value.afterGeneration) ||
      !validIds(value.runtimeContainerIdsBefore) ||
      !validIds(value.runtimeContainerIdsAfter) ||
      !validIds(value.activeRuntimeContainerIdsAfter) ||
      value.activeRuntimeContainerIdsAfter.some(
        (id) => !value.runtimeContainerIdsAfter.includes(id),
      ) ||
      JSON.stringify(value.runtimeContainerIdsBefore) !==
        JSON.stringify(value.runtimeContainerIdsAfter) ||
      (input.action === 'restart' && value.beforeGeneration === value.afterGeneration) ||
      (input.action === 'probe' && value.beforeGeneration !== value.afterGeneration)
    ) {
      throw new Error('Topology provider returned invalid dockerd service evidence');
    }
    return;
  }
  if (input.fault === 'duplicateAgentSession') {
    if (
      value.fault !== 'duplicateAgentSession' ||
      value.nodeKey !== input.nodeKey ||
      typeof value.serverId !== 'string' ||
      value.serverId.length === 0 ||
      value.opened !== true ||
      value.admissionReceived !== false ||
      value.closed !== true
    ) {
      throw new Error('Topology provider returned invalid duplicate Agent session evidence');
    }
    return;
  }
  if (input.fault === 'artifactAudit') {
    if (value.fault !== 'artifactAudit') {
      throw new Error('Topology provider returned a mismatched artifact audit fault kind');
    }
    const runtimeRoot = resolve(requireRuntimeEnv('E2E_RUNTIME_ROOT'));
    const expectedPath = join(runtimeRoot, 'artifact-audit.json');
    const evidencePath = resolve(value.evidencePath);
    const info = lstatSync(evidencePath);
    const bytes = readFileSync(evidencePath);
    if (
      evidencePath !== expectedPath ||
      !evidencePath.startsWith(`${runtimeRoot}${sep}`) ||
      realpathSync(evidencePath) !== evidencePath ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o600 ||
      value.evidenceSha256 !== createHash('sha256').update(bytes).digest('hex') ||
      value.status !== 'clean' ||
      value.playwrightArtifactPolicy !== 'pre-report-empty' ||
      !Number.isSafeInteger(value.filesChecked) ||
      value.filesChecked <= 0 ||
      !Number.isSafeInteger(value.knownSecretsChecked) ||
      value.knownSecretsChecked <= 0
    ) {
      throw new Error('Topology provider returned invalid artifact audit evidence');
    }
    return;
  }
  if (
    value.fault !== 'containerRuntimeDrift' ||
    value.nodeKey !== input.nodeKey ||
    value.containerName !== `nyabase-e2e-${input.runId}-${input.nodeKey}` ||
    value.containerId !== input.containerId ||
    value.runtimeId !== input.runtimeId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.serverId) ||
    typeof value.physicalAbsent !== 'boolean' ||
    typeof value.physicalRunning !== 'boolean' ||
    (input.action === 'remove' && value.physicalAbsent !== true) ||
    (input.action === 'stop' && (value.physicalAbsent || value.physicalRunning)) ||
    (input.action === 'start' && (!value.physicalRunning || value.physicalAbsent))
  ) {
    throw new Error('Topology provider returned invalid container runtime drift evidence');
  }
}
